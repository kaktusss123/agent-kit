/**
 * task-workspace core — session-scoped current-task projection.
 *
 * The authoritative answer to "which managed task workspace does THIS
 * session own": the workspace containing the session cwd when that cwd is
 * managed, otherwise the task of the most recent SUCCESSFUL
 * ensure_task_repo recorded on the CURRENT session branch. Selection is
 * never inferred from the global task catalog, attached repositories,
 * branch names, or modification times: no association is an explicit
 * `none`, a vanished association is an explicit `missing` (identity and
 * workspace are retained, repos are empty).
 *
 * Persistence is the existing session history — no manifest files and no
 * writable inspection API. The host binding appends one custom entry
 * (customType `task-workspace.current`) per successful ensure_task_repo via
 * `pi.appendEntry`; the inspection channel passes the current session branch
 * entries (`ctx.sessionManager.getBranch()`, root → leaf) back into this
 * module. Because the entries live in the session tree, the association
 * survives resume, forks and compaction, follows branch switching, and can
 * never leak another session's selection. A later successful ensure
 * replaces the earlier task (last entry wins).
 *
 * Host-independent: session entries and owner references arrive as plain
 * values; the inspection channel owns the pi wiring and filters settled or
 * history agents out before matching. Repo facts come from ./git, and
 * failed Git reads are reported as unavailable instead of clean.
 */
import { relative } from "node:path";
import {
  findGitRoot,
  getHeadFacts,
  getUpstream,
  git,
  laneIdentity,
  linkedWorktreeFacts,
  parseDirtyStatus,
  realpath,
  taskWorkspacePath,
  underTaskRoot,
} from "./git";
import type { LinkedWorktreeFact } from "./types";

/** customType of the session-history entry recording one successful
 *  ensure_task_repo. Data shape: `{ task: string, worktree: string }`. */
export const SESSION_SELECTION_ENTRY_TYPE = "task-workspace.current";

/** ensure_task_repo outcomes that establish or switch the session's current
 *  task. Failed and refused calls (error, branch_in_use, …) never replace
 *  the association. */
export const ENSURE_SUCCESS_STATUSES: ReadonlySet<string> = new Set([
  "reused",
  "attached",
  "created_from_remote",
  "created",
]);

export function isRecordableEnsureStatus(status: unknown): boolean {
  return typeof status === "string" && ENSURE_SUCCESS_STATUSES.has(status);
}

/** Structural view of the session entries the host passes in (pi custom
 *  entries and any other entry type on the current branch). */
export interface SessionSelectionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export type CurrentTaskState = "none" | "ok" | "missing";
export type CurrentTaskSource = "cwd" | "session";

/** Active workspace RepoOwner reference (one per run-owned subagent matched
 *  to a repository workspace). `state` is the run lifecycle state; settled
 *  and history agents are never included. */
export interface CurrentOwnerRef {
  id: string;
  label: string;
  state: string;
}

/** Host-supplied matcher: active workspace RepoOwner references for one
 *  exact repository workspace path, belonging to the inspected session. */
export type OwnersFor = (repoPath: string) => CurrentOwnerRef[];

const ACTIVE_OWNER_STATES: ReadonlySet<string> = new Set(["running", "waiting_input", "settling", "terminating"]);

/** Associate only well-formed active RepoOwner runs with their exact repo path. */
export function matchActiveOwners(agents: unknown, repoPath: string): CurrentOwnerRef[] {
  const target = realpath(repoPath);
  if (!Array.isArray(agents)) return [];
  const refs: CurrentOwnerRef[] = [];
  for (const value of agents) {
    if (!value || typeof value !== "object") continue;
    const agent = value as { id?: unknown; label?: unknown; run?: unknown };
    if (typeof agent.id !== "string" || !agent.id || typeof agent.label !== "string" || !agent.run || typeof agent.run !== "object") continue;
    const run = agent.run as { workspace?: unknown; state?: unknown; result?: unknown };
    if (typeof run.workspace !== "string" || typeof run.state !== "string" || !ACTIVE_OWNER_STATES.has(run.state)) continue;
    // Any terminal result marker disqualifies a stale/malformed active state.
    if (run.result !== undefined && run.result !== null) continue;
    if (realpath(run.workspace) !== target) continue;
    refs.push({ id: agent.id, label: agent.label, state: run.state });
  }
  return refs;
}

export interface CurrentRepoDirty {
  staged: string[];
  unstaged: string[];
  /** False when the status read failed: empty lists then mean unknown,
   *  never "clean". Untracked paths count as unstaged (existing contract). */
  available: boolean;
}

export interface CurrentRepo {
  name: string;
  path: string;
  kind: "canonical" | "lane";
  slot: string | null;
  classification: "MANAGED_TASK_WORKTREE";
  branch: string;
  detached: boolean;
  headSha: string | null;
  upstream: string | null;
  dirty: CurrentRepoDirty;
  /** Truthful Git read health for this worktree. False means branch, HEAD,
   *  and dirty facts are unavailable and must not render as known values. */
  gitAvailable: boolean;
  owners: CurrentOwnerRef[];
}

export interface CurrentTaskProjection {
  state: CurrentTaskState;
  /** Canonical task identity (the workspace directory name). */
  identity: string | null;
  /** Task workspace path under the task root. */
  workspace: string | null;
  /** How this task was selected: managed session cwd, or the latest
   *  successful ensure_task_repo on the current session branch. */
  source: CurrentTaskSource | null;
  repos: CurrentRepo[];
}

/** Most recent selection entry on the branch (entries arrive root → leaf,
 *  so the last match is the latest successful ensure). */
function selectionFromBranch(entries: SessionSelectionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "custom" || entry.customType !== SESSION_SELECTION_ENTRY_TYPE) {
      continue;
    }
    const task = (entry.data as { task?: unknown } | undefined)?.task;
    if (typeof task === "string" && task) return task;
  }
  return null;
}

/** Managed-cwd selection: the identity of the workspace whose managed
 *  worktree contains the session cwd (the cwd's git root is under the task
 *  root — the same criterion as the MANAGED_TASK_WORKTREE classification). */
function selectionFromCwd(cwd: string, taskRoot: string): string | null {
  const abs = realpath(cwd);
  const root = findGitRoot(abs);
  if (!root || !underTaskRoot(root, taskRoot)) return null;
  const rel = relative(taskRoot, root);
  const identity = rel.split("/")[0];
  return identity ? identity : null;
}

/** Build the session-scoped current-task projection. Never throws: missing
 *  associations are `none`, vanished workspaces are `missing`, and failed
 *  per-repo Git reads surface as unavailable facts. */
export async function buildCurrentTaskProjection(opts: {
  cwd: string;
  taskRoot: string;
  branchEntries: SessionSelectionEntry[];
  owners?: OwnersFor;
}): Promise<CurrentTaskProjection> {
  const cwdIdentity = selectionFromCwd(opts.cwd, opts.taskRoot);
  const identity = cwdIdentity ?? selectionFromBranch(opts.branchEntries);
  if (!identity) {
    return { state: "none", identity: null, workspace: null, source: null, repos: [] };
  }
  const source: CurrentTaskSource = cwdIdentity ? "cwd" : "session";
  const workspace = taskWorkspacePath(identity, opts.taskRoot);
  const repos = await readWorkspaceRepos(workspace, opts.owners);
  return {
    state: repos.length > 0 ? "ok" : "missing",
    identity,
    workspace,
    source,
    repos,
  };
}

/** Current-task repo facts for ONE workspace directory: the same repo set
 *  the global catalog scan sees (linked worktrees only), enriched with
 *  detached state, truthful availability, and matched owners. */
export async function readWorkspaceRepos(
  workspace: string,
  owners?: OwnersFor,
): Promise<CurrentRepo[]> {
  const facts = await linkedWorktreeFacts(workspace);
  const linked = new Map<string, LinkedWorktreeFact>(
    facts.map((f) => [f.name, { path: f.path, commonDir: f.commonDir }]),
  );
  const repos: CurrentRepo[] = [];
  for (const [name, worktree] of linked) {
    repos.push(
      await readCurrentRepo(name, worktree.path, laneIdentity(name, linked), owners),
    );
  }
  return repos;
}

async function readCurrentRepo(
  name: string,
  path: string,
  identity: { kind: "canonical" | "lane"; slot: string | null },
  owners?: OwnersFor,
): Promise<CurrentRepo> {
  const head = await getHeadFacts(path);
  const status = await git(path, "status", "--porcelain=v2", "--no-renames");
  const dirtyAvailable = status.ok;
  const dirty = parseDirtyStatus(dirtyAvailable ? status.stdout : "");
  const upstream = head.available && head.branch ? await getUpstream(path, head.branch) : null;
  return {
    name,
    path,
    kind: identity.kind,
    slot: identity.slot,
    classification: "MANAGED_TASK_WORKTREE",
    branch: head.branch,
    detached: head.detached,
    headSha: head.sha,
    upstream,
    dirty: {
      staged: dirty.staged,
      unstaged: dirty.unstaged,
      available: dirtyAvailable,
    },
    gitAvailable: head.available && dirtyAvailable,
    owners: owners ? owners(path) : [],
  };
}
