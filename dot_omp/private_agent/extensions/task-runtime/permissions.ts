/**
 * Repository-integrity permission helpers + OMP tool_call/tool_result
 * runtime wiring (Stage 5).
 *
 * Pre-tool guard for `edit`/`write`: blocks when target is outside the
 * writable roots for the bound session's role/task.
 *
 * Post-tool guard for `bash`: detects mutation of protected repos
 * (cracker: registered source repos; implementer: source checkouts,
 * reference repos) and rolls back agent-introduced changes.
 */

import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { artifactsDir, worktreePath } from "./paths.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { TaskManifestV2, ExecFn } from "./types.ts";
import { loadManifest } from "./storage.ts";
import { isValidTaskId } from "./paths.ts";

export type Role = "cracker" | "implementer";

export interface PolicyContext {
  role: Role;
  manifest: TaskManifestV2;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  canonical?: string;
  existsOnDisk?: boolean;
  authorizedRoot?: string;
}

/**
 * Resolve `p` to its canonical (realpath) form. Returns null when path
 * does not exist (use `canonicalizeForWrite` for pre-tool write guards).
 * When `cwd` is provided, relative paths are resolved against it.
 * Without `cwd`, `process.cwd()` is used as fallback.
 */
export function canonicalize(p: string, cwd?: string): string | null {
  if (!p) return null;
  const base = cwd ?? process.cwd();
  const abs = isAbsolute(p) ? p : resolve(base, p);
  if (!existsSync(abs)) return null;
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/**
 * Like {@link canonicalize} but works for targets that may not exist yet
 * (e.g. the {@link write} tool creates new files). The longest existing
 * prefix is resolved, the missing tail appended and normalized with
 * {@link resolve resolve()} so explicit {@code ..} segments collapse.
 * When {@link cwd} is supplied, relative paths resolve against it;
 * otherwise {@link process.cwd()} is used.
 */
export function canonicalizeForWrite(target: string, cwd?: string): {
  canonical: string;
  existsOnDisk: boolean;
} {
  const base = cwd ?? process.cwd();
  const abs = isAbsolute(target) ? target : resolve(base, target);
  if (existsSync(abs)) {
    const can = realpathSync(abs);
    return { canonical: can, existsOnDisk: true };
  }
  let cur = abs;
  const tail: string[] = [];
  while (cur !== "/" && cur !== "." && cur !== dirname(cur) && !existsSync(cur)) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  let real: string;
  try { real = realpathSync(cur); } catch { real = cur; }
  const reattached = tail.length === 0 ? real : real + sep + tail.join(sep);
  return { canonical: resolve(reattached), existsOnDisk: false };
}

export function pathContained(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent + sep);
}

export function roleForSession(
  manifest: TaskManifestV2,
  sessionFile: string | undefined,
): Role | null {
  if (!sessionFile) return null;
  if (manifest.sessions.cracker?.sessionFile === sessionFile) return "cracker";
  if (manifest.sessions.implementer?.sessionFile === sessionFile) return "implementer";
  return null;
}

export function writableRoots(ctx: PolicyContext): {
  paths: string[];
  repos: Record<string, string>;
} {
  const paths: string[] = [];
  const repos: Record<string, string> = {};

  if (ctx.role === "cracker") {
    // Cracker has no generic writable filesystem roots.
    // Persist state through: task_write_artifact, task_record_decision,
    // task_set_verification, task_mark_ready.
    return { paths, repos };
  }

  for (const [name, repo] of Object.entries(ctx.manifest.repos)) {
    if (repo.role === "reference") continue;
    if (!repo.worktreePath) continue;
    const can = canonicalize(repo.worktreePath);
    if (!can) continue;
    paths.push(can);
    repos[name] = can;
  }
  return { paths, repos };
}

export function evaluateWrite(
  ctx: PolicyContext,
  target: string,
  cwd?: string,
): PolicyDecision {
  const { canonical, existsOnDisk } = canonicalizeForWrite(target, cwd);
  const candidateRoots = writableRoots(ctx).paths;
  for (const r of candidateRoots) {
    const rc = canonicalize(r) ?? r;
    if (pathContained(rc, canonical) || rc === canonical) {
      return { allowed: true, canonical, existsOnDisk, authorizedRoot: rc };
    }
  }
  const forbidden: string[] = [];
  if (ctx.role === "cracker") {
    for (const repo of Object.values(ctx.manifest.repos)) {
      forbidden.push(`source repo ${repo.name} (${repo.sourcePath})`);
    }
  } else {
    for (const [name, repo] of Object.entries(ctx.manifest.repos)) {
      if (repo.role === "reference") {
        forbidden.push(`reference repo ${name} (${repo.sourcePath})`);
      } else if (repo.worktreePath && resolve(repo.worktreePath) !== canonical) {
        forbidden.push(`original source checkout for ${name} (${repo.sourcePath})`);
      }
    }
    const snapDir = resolve(artifactsDir(ctx.manifest.id), "..", "snapshots");
    forbidden.push(`approval snapshot dir (${snapDir})`);
  }
  return {
    allowed: false,
    canonical,
    existsOnDisk,
    reason: `role=${ctx.role}: target "${canonical}" is not under any writable root. Forbidden targets include: ${forbidden.join(", ")}`,
  };
}

export interface RepoFingerprint {
  head: string;
  trackedDelta: string;
  untracked: string;
}

export function fingerprintFromGitOutput(
  head: string,
  statusPorcelain: string,
): RepoFingerprint {
  const records = statusPorcelain.split("\0");
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const rec of records) {
    if (!rec) continue;
    const code = rec.slice(0, 2);
    const file = rec.slice(3);
    if (code === "??") untracked.push(file);
    else tracked.push(`${code} ${file}`);
  }
  tracked.sort();
  untracked.sort();
  return { head, trackedDelta: tracked.join("\n"), untracked: untracked.join("\n") };
}

export function fingerprintsEqual(a: RepoFingerprint, b: RepoFingerprint): boolean {
  return a.head === b.head && a.trackedDelta === b.trackedDelta && a.untracked === b.untracked;
}

export function protectedRepos(
  ctx: PolicyContext,
): { name: string; canonical: string }[] {
  const out: { name: string; canonical: string }[] = [];
  for (const [name, repo] of Object.entries(ctx.manifest.repos)) {
    const can = canonicalize(repo.sourcePath);
    if (can) out.push({ name, canonical: can });
  }
  return out;
}

export function pathInsideAnyProtected(
  ctx: PolicyContext,
  p: string,
): { inside: boolean; name?: string; canonical?: string } {
  const c = canonicalize(p);
  if (!c) return { inside: false };
  for (const { name, canonical } of protectedRepos(ctx)) {
    if (pathContained(canonical, c)) return { inside: true, name, canonical };
  }
  return { inside: false };
}

/**
 * Capture pre-call fingerprints of protected repos for a task. Keyed by
 * canonical path so tool_result can re-measure and compare.
 */
async function captureFingerprints(
  exec: ExecFn,
  ctx: PolicyContext,
): Promise<Map<string, RepoFingerprint>> {
  const out = new Map<string, RepoFingerprint>();
  for (const { canonical } of protectedRepos(ctx)) {
    try {
      const head = await headSha(exec, canonical);
      const status = await statusPorcelain(exec, canonical);
      out.set(canonical, fingerprintFromGitOutput(head, status));
    } catch { /* ignore — repo gone or not git */ }
  }
  return out;
}

async function headSha(exec: ExecFn, repoPath: string): Promise<string> {
  const r = await exec("git", ["-C", repoPath, "rev-parse", "HEAD"]);
  if (r.code !== 0) throw new Error("rev-parse failed");
  return r.stdout.trim();
}

async function statusPorcelain(exec: ExecFn, repoPath: string): Promise<string> {
  const r = await exec(
    "git",
    ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  if (r.code !== 0) throw new Error("status failed");
  return r.stdout;
}

interface PendingFingerprints {
  ctx: PolicyContext;
  before: Map<string, RepoFingerprint>;
}

/**
 * Bind runtime write policy into the OMP event bus:
 *  - `tool_call` pre-guard for `edit` / `write` blocks paths outside writable roots
 *  - `tool_result` post-guard for `bash` detects protected-repo mutation and rolls back
 */
export function registerWritePolicy(pi: ExtensionAPI): void {
  const exec: ExecFn = async (cmd, args, options) => {
    const r = await pi.exec(cmd, args, options);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  // Pending fingerprints per toolCallId (bash only).
  const pending = new Map<string, PendingFingerprints>();

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const target = extractPath(event.input);
      if (!target) return;
      // Pass through recognized OMP internal resource URIs
      // (xd://, skill://, memory://, agent://, mcp://, omp://).
      if (target) {
        const t = target as string;
        if (t.startsWith('xd://') || t.startsWith('skill://') ||
            t.startsWith('memory://') || t.startsWith('agent://') ||
            t.startsWith('mcp://') || t.startsWith('omp://')) {
          return undefined;
        }
      }
      const manifest = await activeManifestForContext(ctx);
      if (!manifest) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const role = roleForSession(manifest, sessionFile);
      if (!role) return;
      const decision = evaluateWrite({ role, manifest }, target, ctx.cwd);
      if (!decision.allowed) {
        return { block: true, reason: decision.reason ?? "policy denial" };
      }
      return undefined;
    } catch (e) {
      return { block: true, reason: `policy enforcement error: ${(e as Error).message}` };
    }
  });



  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const manifest = await activeManifestForContext(ctx);
    if (!manifest) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const role = roleForSession(manifest, sessionFile);
    if (!role) return;
    const before = await captureFingerprints(exec, { role, manifest });
    pending.set(event.toolCallId, { ctx: { role, manifest }, before });
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const p = pending.get(event.toolCallId);
    if (!p) return;
    pending.delete(event.toolCallId);
    const after = await captureFingerprints(exec, p.ctx);
    const mutated: string[] = [];
    for (const [path, beforeFp] of p.before) {
      const afterFp = after.get(path);
      if (!afterFp) continue;
      if (!fingerprintsEqual(beforeFp, afterFp)) mutated.push(path);
    }
    if (mutated.length === 0) return;

    // §26.5: only safe-rollback repos that were CLEAN before the bash call.
    // If a repo was dirty before AND changed further, we cannot isolate
    // agent-introduced changes from pre-existing work → loud failure, no reset.
    const safe: { path: string; headBefore: string }[] = [];
    const unsafe: string[] = [];
    for (const path of mutated) {
      const beforeFp = p.before.get(path)!;
      if (beforeFp.trackedDelta === "" && beforeFp.untracked === "") {
        safe.push({ path, headBefore: beforeFp.head });
      } else {
        unsafe.push(path);
      }
    }
    const rollbackErrors: string[] = [];
    for (const { path, headBefore } of safe) {
      try {
        // Restore tracked files to pre-call HEAD. Do NOT clean untracked
        // files — they were created by the agent during bash, and restoring
        // HEAD alone discards them without destroying pre-existing work
        // (there was none).
        const reset = await exec("git", ["-C", path, "reset", "--hard", headBefore]);
        if (reset.code !== 0) {
          throw new Error(`reset failed: ${reset.stderr}`);
        }
        // P0-6: NEVER git clean -fdx. The repo was "clean" only by git status
        // --porcelain, which excludes .gitignore-d files (e.g. .env).
        // git clean -fdx would destroy those pre-existing ignored user files.
        // Agent-created untracked files remain on disk as evidence.
      } catch (e) {
        rollbackErrors.push(`${path}: ${(e as Error).message}`);
      }
    }
    // Append policy_violation event
    try {
      const events = (await import("./events.ts")).recordEvent;
      await events(p.ctx.manifest.id, "policy_violation", {
        toolCallId: event.toolCallId,
        mutatedRepos: mutated,
        rollbackErrors,
      });
    } catch { /* events dir may not exist outside a real run */ }
    const unsafeMsg = unsafe.length > 0
      ? ` POLICY_VIOLATION_UNSAFE: repos [${unsafe.join(", ")}] were dirty before bash — cannot safely rollback agent changes without destroying pre-existing work. Manual cleanup required.`
      : "";
    return {
      content: [{
        type: "text" as const,
        text: `POLICY_VIOLATION: bash mutated protected repos [${mutated.join(", ")}].` +
              (safe.length > 0 ? ` ${safe.length} repo(s) rolled back to pre-call state.` : "") +
              unsafeMsg +
              (rollbackErrors.length ? ` Rollback errors: ${rollbackErrors.join("; ")}` : ""),
      }],
      isError: true,
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!["read", "grep", "glob"].includes(event.toolName)) return;
      const target = extractPath(event.input);
      if (!target) return;
      // Pass through recognized internal resource URIs
      if (typeof target === "string" &&
          (target.startsWith("xd://") || target.startsWith("skill://") ||
           target.startsWith("memory://") || target.startsWith("agent://") ||
           target.startsWith("mcp://") || target.startsWith("omp://"))) {
        return undefined;
      }
      const manifest = await activeManifestForContext(ctx);
      if (!manifest) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const role = roleForSession(manifest, sessionFile);
      if (!role) return;

      const { canonical } = canonicalizeForWrite(target, ctx.cwd);

      // Allowed: under any attached task worktree (both roles).
      for (const [, repo] of Object.entries(manifest.repos)) {
        if (!repo.worktreePath) continue;
        const wt = canonicalize(repo.worktreePath) ?? repo.worktreePath;
        if (pathContained(wt, canonical)) return undefined;
      }

      // Blocked: under any human source checkout.
      for (const [, repo] of Object.entries(manifest.repos)) {
        const src = canonicalize(repo.sourcePath);
        if (!src) continue;
        if (pathContained(src, canonical)) {
          return {
            block: true,
            reason: `role=${role}: reading from human source checkout "${repo.name}" (${repo.sourcePath}) is not permitted. Use task worktrees instead.`,
          };
        }
      }
      // Unknown path — block.
      return { block: true, reason: `role=${role}: target "${target}" is not under any readable task root.` };
    } catch (e) {
      return { block: true, reason: `read policy error: ${(e as Error).message}` };
    }
  });


}

async function activeManifestForContext(ctx: {
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined };
}): Promise<TaskManifestV2 | null> {
  // Primary lookup: session binding (works in cracker & implementer regardless of cwd).
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) {
    const bySession = await findManifestBySession(sessionFile);
    if (bySession) return bySession;
  }
  // Fallback: cwd-derived task id (works when cwd happens to be in ~/.omp/tasks/<id>).
  const home = Bun.env.HOME ?? process.env.HOME ?? "";
  const tasksRoot = resolve(home, ".omp", "tasks");
  if (ctx.cwd.startsWith(tasksRoot + sep) || ctx.cwd === tasksRoot) {
    const rel = ctx.cwd.slice(tasksRoot.length + 1);
    const id = rel.split(sep)[0];
    if (id && isValidTaskId(id)) {
      try { return await loadManifest(id); } catch { /* fall through */ }
    }
  }
  return null;
}

async function findManifestBySession(sessionFile: string): Promise<TaskManifestV2 | null> {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = Bun.env.HOME ?? process.env.HOME ?? "";
  const root = resolve(home, ".omp", "tasks");
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const e of entries) {
    if (!isValidTaskId(e)) continue;
    try {
      const m = await loadManifest(e);
      if (m.sessions.cracker?.sessionFile === sessionFile) return m;
      if (m.sessions.implementer?.sessionFile === sessionFile) return m;
    } catch { /* not a V2 manifest or unreadable; skip */ }
  }
  return null;
}

function extractPath(input: Record<string, unknown> | unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  // Write tool uses `path`; edit tool uses `path` (or `file_path` legacy alias).
  const p = obj.path ?? obj.file_path;
  return typeof p === "string" ? p : undefined;
}
