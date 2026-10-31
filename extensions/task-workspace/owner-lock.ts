/**
 * owner-lock — cross-process ownership of one managed task worktree.
 *
 * Exactly one live RepoOwner may write to one managed worktree on one host,
 * no matter how many independent Pi (Main) processes are running. The
 * in-process registry of the workspace run layer cannot enforce that: two
 * Main processes have two registries. This module adds the missing piece as
 * a small local lease next to the task workspace:
 *
 *   <taskRoot>/.owners/<sha256 of the worktree path>.json
 *
 * Contract:
 * - The right to write is acquired BEFORE a child is dispatched and released
 *   only after the child is provably gone and the final Git read finished;
 *   callers own that ordering (the workspace run layer releases from the
 *   settlement path, never from a fire-and-forget timer).
 * - Two different exclusions, never confused: the record itself is the
 *   durable ownership claim, and a short-lived claim file serializes the
 *   read-decide-replace step. Two processes that both find a dead record
 *   therefore cannot both replace it — the loser re-reads and sees the
 *   winner's live record and is refused. The claim is recoverable on its own
 *   terms: a claim whose process is dead is removed, because a dead claimant
 *   performs no further filesystem work.
 * - The record never expires by age. It names the processes that justify it:
 *   the parent (the Main process that dispatched the run) and, once the child
 *   exists, the child. Each identity is `pid` plus the kernel-reported process
 *   start time, so a recycled pid is not mistaken for the previous owner.
 * - A record may be taken over only when EVERY recorded process is provably
 *   dead. A dead parent with a live child therefore still owns the worktree —
 *   the crash of one Pi process must not hand a running RepoOwner's worktree
 *   to a second owner. When liveness cannot be verified (unreadable record,
 *   foreign hostname, unverifiable process identity) the refusal wins: fail
 *   closed, never guess.
 * - Releasing a record that belongs to a different token is impossible: the
 *   holder deletes only its own record, and a replace happens only for a
 *   record whose every recorded process is provably dead.
 *
 * Guarantee boundary: local filesystems on one host, where exclusive file
 * creation and pid identities (Linux `/proc/<pid>/stat`, macOS
 * `ps -o lstart=`) are trustworthy. A task root shared between physical hosts over a network
 * filesystem is out of scope: a record written on another hostname is
 * refused, never stolen.
 *
 * Host-independent: node/fs only, no Pi SDK, no environment lookups. Callers
 * pass the resolved task root and an absolute worktree path explicitly.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Directory under the task root that holds owner records. */
export const OWNER_DIR_NAME = ".owners";

const RECORD_VERSION = 1;
const ACQUIRE_ATTEMPTS = 3;

/** Identity of one OS process: pid plus the platform-reported start time. */
export interface OwnerProcessIdentity {
  pid: number;
  /** Opaque `platform:start` string; "unknown" when the platform cannot report it. */
  start: string;
}

export interface OwnerRecord {
  version: number;
  /** Unique per acquisition; only the holder presenting it may release. */
  token: string;
  /** Absolute worktree path this record owns. */
  workspace: string;
  host: string;
  /** `dispatching`: the parent holds it and the child is not recorded yet. */
  state: "dispatching" | "owned";
  acquiredAt: number;
  updatedAt: number;
  parent: OwnerProcessIdentity;
  child?: OwnerProcessIdentity;
  agentId?: string;
}

/**
 * `free` — no record; `owned` — a recorded process is alive; `stale` — every
 * recorded process is provably dead (recoverable); `foreign_host` — written
 * on another host; `unknown` — present but not verifiable (unreadable,
 * mismatched workspace, unreadable process identity).
 */
export type OwnerState = "free" | "owned" | "stale" | "foreign_host" | "unknown";

export interface OwnerProcessView extends OwnerProcessIdentity {
  role: "parent" | "child";
  alive: boolean;
}

/** Observable ownership of one worktree (diagnostics; never a secret). */
export interface OwnerView {
  state: OwnerState;
  workspace: string;
  recordPath: string;
  holder?: {
    token: string;
    state: OwnerRecord["state"];
    agentId?: string;
    acquiredAt: number;
    updatedAt: number;
    processes: OwnerProcessView[];
  };
  /** Why the state is not `free`/`owned` (unknown/foreign/residual). */
  problem?: string;
}

/** Held ownership right of one workspace run. */
export interface OwnerLease {
  taskRoot: string;
  workspace: string;
  token: string;
  recordPath: string;
}

export type AcquireResult =
  | { ok: true; lease: OwnerLease }
  | { ok: false; reason: "owned" | "unverifiable" | "contended"; view: OwnerView };

const UNKNOWN_START = "unknown";

/** Record path for one worktree (deterministic, filesystem-length safe). */
export function ownerRecordPath(taskRoot: string, workspace: string): string {
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 32);
  return path.join(taskRoot, OWNER_DIR_NAME, `${key}.json`);
}

/** Identity of the calling process. */
export function currentProcessIdentity(): OwnerProcessIdentity {
  return { pid: process.pid, start: readProcessStart(process.pid) ?? UNKNOWN_START };
}

/** Short-lived claim file next to the record: serializes record mutation. */
function ownerClaimPath(recordPath: string): string {
  return `${recordPath}.claim`;
}

/** How long an acquisition rides out another process's claim section. */
const CLAIM_WAIT_MS = 300;
const CLAIM_POLL_MS = 15;

/**
 * Acquire the worktree for the calling process.
 *
 * Two kinds of exclusion, deliberately separated:
 * - the durable RECORD is the ownership claim and names every process that
 *   justifies it; it is never replaced while any recorded process is alive, so
 *   a live owner (including a child whose Main died) is never displaced;
 * - a short-lived CLAIM file guards the read-decide-write step, so two
 *   processes that both judge a dead record recoverable cannot both replace it
 *   (the loser re-reads and sees the winner's live record). The claim's own
 *   holder is recoverable the same way: a claim whose process is dead is
 *   removed, because a dead claimant performs no further filesystem work.
 *
 * Refusal is a result, not an exception: the caller must be able to say who
 * holds the worktree. The only bounded wait is for a concurrent claim section
 * (milliseconds), never for a live owner.
 */
export async function acquireOwnerLease(
  taskRoot: string,
  workspace: string,
  opts: { agentId?: string; now?: number } = {},
): Promise<AcquireResult> {
  const recordPath = ownerRecordPath(taskRoot, workspace);
  const claimPath = ownerClaimPath(recordPath);
  const now = opts.now ?? Date.now();
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: "unverifiable",
      view: {
        state: "unknown",
        workspace,
        recordPath,
        problem: `cannot create the owner directory: ${errorMessage(error)}`,
      },
    };
  }

  const claimDeadline = Date.now() + CLAIM_WAIT_MS;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (!takeClaim(claimPath)) {
      const claim = readClaim(claimPath);
      if (claim && !processAlive(claim)) {
        // The claimant died inside its critical section: its claim is spent.
        dropClaim(claimPath);
        continue;
      }
      if (Date.now() < claimDeadline) {
        await sleep(CLAIM_POLL_MS);
        continue;
      }
      return { ok: false, reason: "contended", view: describeOwner(taskRoot, workspace) };
    }
    try {
      const view = describeOwner(taskRoot, workspace);
      if (view.state === "owned") return { ok: false, reason: "owned", view };
      if (view.state === "unknown" || view.state === "foreign_host") {
        return { ok: false, reason: "unverifiable", view };
      }
      // Free, or owned only by provably dead processes: replace the record.
      const record: OwnerRecord = {
        version: RECORD_VERSION,
        token: randomUUID(),
        workspace,
        host: os.hostname(),
        state: "dispatching",
        acquiredAt: now,
        updatedAt: now,
        parent: currentProcessIdentity(),
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
      };
      writeRecord(recordPath, record);
      return { ok: true, lease: { taskRoot, workspace, token: record.token, recordPath } };
    } finally {
      dropClaim(claimPath);
    }
  }
  return { ok: false, reason: "contended", view: describeOwner(taskRoot, workspace) };
}

/** Take the short-lived claim; false when another process holds it. */
function takeClaim(claimPath: string): boolean {
  const claim: OwnerProcessIdentity = currentProcessIdentity();
  try {
    fs.writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function readClaim(claimPath: string): OwnerProcessIdentity | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(claimPath, "utf8"));
    return isProcessIdentity(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function dropClaim(claimPath: string): void {
  try {
    fs.unlinkSync(claimPath);
  } catch {
    // already gone (dead-claim recovery) — nothing to drop
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register the dispatched child in the lease. Until this succeeds the record
 * names only the parent, so a parent crash between dispatch and registration
 * would look dead — the caller treats `false` as a failed acquisition and
 * stops the child instead of running unowned.
 */
export function recordOwnerChild(
  lease: OwnerLease,
  childPid: number | undefined,
  opts: { agentId?: string; now?: number } = {},
): boolean {
  const record = readRecord(lease.recordPath);
  if (!record || record.token !== lease.token) return false;
  if (childPid === undefined || !Number.isInteger(childPid) || childPid <= 0) return false;
  const updated: OwnerRecord = {
    ...record,
    state: "owned",
    updatedAt: opts.now ?? Date.now(),
    child: { pid: childPid, start: readProcessStart(childPid) ?? UNKNOWN_START },
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  };
  try {
    writeRecord(lease.recordPath, updated);
    return true;
  } catch {
    return false;
  }
}

/** Release the lease. Only the holder's own record is ever removed. */
export function releaseOwnerLease(lease: OwnerLease): boolean {
  const record = readRecord(lease.recordPath);
  if (!record) return true;
  if (record.token !== lease.token) return false;
  try {
    fs.unlinkSync(lease.recordPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Observable state of one worktree's ownership. */
export function describeOwner(taskRoot: string, workspace: string): OwnerView {
  const recordPath = ownerRecordPath(taskRoot, workspace);
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "free", workspace, recordPath };
    }
    return {
      state: "unknown",
      workspace,
      recordPath,
      problem: `owner record is unreadable: ${errorMessage(error)}`,
    };
  }
  const record = parseRecord(raw);
  if (!record) {
    return {
      state: "unknown",
      workspace,
      recordPath,
      problem: "owner record is not a valid ownership record",
    };
  }
  if (record.workspace !== workspace) {
    return {
      state: "unknown",
      workspace,
      recordPath,
      problem: `owner record belongs to a different workspace: ${record.workspace}`,
    };
  }
  const processes: OwnerProcessView[] = [
    { role: "parent", ...record.parent, alive: processAlive(record.parent) },
  ];
  if (record.child) {
    processes.push({ role: "child", ...record.child, alive: processAlive(record.child) });
  }
  const holder = {
    token: record.token,
    state: record.state,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    acquiredAt: record.acquiredAt,
    updatedAt: record.updatedAt,
    processes,
  };
  const host = os.hostname();
  if (record.host !== host) {
    return {
      state: "foreign_host",
      workspace,
      recordPath,
      holder,
      problem: `record was written on host ${record.host}, this host is ${host}`,
    };
  }
  if (processes.some((p) => p.alive)) {
    return { state: "owned", workspace, recordPath, holder };
  }
  return { state: "stale", workspace, recordPath, holder };
}

/**
 * Remove a worktree's record when no live owner exists. Used by teardown
 * after its own guards proved nothing runs there; a live record is left in
 * place and reported instead.
 */
export function removeDeadOwnerRecord(taskRoot: string, workspace: string): boolean {
  const view = describeOwner(taskRoot, workspace);
  if (view.state === "free") return true;
  if (view.state === "owned" || view.state === "unknown" || view.state === "foreign_host") return false;
  try {
    fs.unlinkSync(view.recordPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Human-readable refusal for a second owner: which worktree, who holds it,
 * how to inspect it, and whether a retry can succeed. No secrets: identities
 * are process ids, start times, and the run's agent id.
 */
export function describeOwnerRefusal(view: OwnerView): string {
  const where = `workspace ${view.workspace}`;
  switch (view.state) {
    case "owned": {
      const facts = (view.holder?.processes ?? [])
        .filter((p) => p.alive)
        .map((p) => `pid ${p.pid} (${p.role}${p.start === UNKNOWN_START ? "" : `, started ${p.start.replace(/^[a-z]+:/, "")}`})`)
        .join("; ");
      const who = view.holder?.agentId ? `, run ${view.holder.agentId}` : "";
      return (
        `${where} is owned by another RepoOwner on this host: ${facts}${who}. ` +
        `The right to write is released only after that owner's child process exits and its final Git check finishes. ` +
        `Inspect with task_status (per-worktree owner state) or subagent op=status; retry only after that owner settles.`
      );
    }
    case "stale":
      return (
        `${where} has an owner record whose processes are all dead, but releasing it did not succeed; ` +
        `inspect ${view.recordPath} and retry.`
      );
    case "foreign_host":
      return (
        `${where} has an owner record from another host (${view.problem}); ` +
        `cross-host ownership is not supported, so a second owner is refused. ` +
        `Inspect ${view.recordPath} on the host that recorded it.`
      );
    default:
      return (
        `${where} cannot be verified as free: ${view.problem ?? "unknown owner record state"}. ` +
        `Inspect ${view.recordPath}; remove it manually only when no RepoOwner runs for this worktree.`
      );
  }
}

// ------------------------------------------------------------------ records

function writeRecord(recordPath: string, record: OwnerRecord): void {
  const tmp = `${recordPath}.tmp-${record.token}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(tmp, recordPath);
}

function readRecord(recordPath: string): OwnerRecord | undefined {
  try {
    return parseRecord(fs.readFileSync(recordPath, "utf8"));
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string): OwnerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<OwnerRecord>;
  if (r.version !== RECORD_VERSION) return undefined;
  if (typeof r.token !== "string" || !r.token) return undefined;
  if (typeof r.workspace !== "string" || !r.workspace) return undefined;
  if (typeof r.host !== "string" || !r.host) return undefined;
  if (r.state !== "dispatching" && r.state !== "owned") return undefined;
  if (typeof r.acquiredAt !== "number" || typeof r.updatedAt !== "number") return undefined;
  if (!isProcessIdentity(r.parent)) return undefined;
  if (r.child !== undefined && !isProcessIdentity(r.child)) return undefined;
  if (r.agentId !== undefined && typeof r.agentId !== "string") return undefined;
  return r as OwnerRecord;
}

function isProcessIdentity(value: unknown): value is OwnerProcessIdentity {
  const id = value as Partial<OwnerProcessIdentity> | undefined;
  return (
    !!id &&
    typeof id === "object" &&
    typeof id.pid === "number" &&
    Number.isInteger(id.pid) &&
    id.pid > 0 &&
    typeof id.start === "string" &&
    id.start.length > 0
  );
}

// ---------------------------------------------------------------- liveness

function processAlive(identity: OwnerProcessIdentity): boolean {
  if (identity.pid === process.pid) return true;
  const current = readProcessStart(identity.pid);
  if (current === undefined) {
    // Alive but identity unverifiable: conservative, ownership is not stolen.
    return pidExists(identity.pid);
  }
  if (identity.start !== UNKNOWN_START && current !== identity.start) return false;
  return pidExists(identity.pid);
}

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Platform-reported process start time, prefixed with its source. */
function readProcessStart(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // `comm` (field 2) may contain spaces and parentheses: everything after
      // the LAST ")" is space-separated, starting at field 3 (state). The
      // start time is field 22, i.e. index 19 of that remainder.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const start = fields[19];
      return start ? `linux:${start}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out ? `darwin:${out}` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
