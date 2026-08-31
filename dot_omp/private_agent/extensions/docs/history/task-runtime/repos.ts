/**
 * Repository registration and worktree lifecycle helpers.
 *
 * Pure helpers — callers (commands/tools) supply the argv-based exec
 * function (`pi.exec`). Tests pass an in-memory exec.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { taskRootDir, worktreePath, worktreesDir } from "./paths.ts";
import type { ExecFn, RepoEntry, RepoRole } from "./types.ts";

export class RepoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoValidationError";
  }
}

export class DuplicateRepoError extends Error {
  constructor(public readonly name: string) {
    super(`repository "${name}" already registered`);
    this.name = "DuplicateRepoError";
  }
}

export class DuplicateCanonicalPathError extends Error {
  constructor(public readonly canonicalPath: string) {
    super(`repository at "${canonicalPath}" is already registered`);
    this.name = "DuplicateCanonicalPathError";
  }
}

export class PrimaryImmutableError extends Error {
  constructor() {
    super(`primary repo cannot be replaced through attach`);
    this.name = "PrimaryImmutableError";
  }
}

/**
 * Resolve `path` to its git top-level. Throws if not inside a git repo.
 */
export async function canonicalRepoRoot(
  exec: ExecFn,
  path: string,
): Promise<string> {
  if (!path || path.trim() === "") {
    throw new RepoValidationError("path is empty");
  }
  const r = await exec("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) {
    throw new RepoValidationError(`not a git repo: ${path}`);
  }
  const top = r.stdout.trim();
  if (!top) throw new RepoValidationError(`empty git toplevel for ${path}`);
  return resolve(top);
}

/**
 * Validate that a name is a valid repo key (used as both manifest key
 * and worktree directory basename).
 */
export function isValidRepoName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export function deriveRepoName(canonicalPath: string): string {
  const base = canonicalPath.split("/").filter(Boolean).pop() ?? "";
  if (!isValidRepoName(base)) {
    throw new RepoValidationError(
      `cannot derive a safe repo name from "${canonicalPath}" (basename "${base}" fails validation)`,
    );
  }
  return base;
}

/**
 * Register a new repo. Enforces:
 *   - canonical top-level resolution
 *   - name collision rejection
 *   - canonical-path collision rejection
 *   - role is target or reference (primary is bound at createTask)
 *   - empty path rejection
 */
export interface AttachInput {
  existing: RepoEntry[];
  rawPath: string;
  role: RepoRole;
  /** when `true`, allows attach during ready_for_approval phase */
  allowReplacePrimary?: never; // primary is always immutable here
}

export async function attachRepo(
  exec: ExecFn,
  input: AttachInput,
): Promise<RepoEntry> {
  const role = input.role;
  if (role !== "target" && role !== "reference") {
    throw new RepoValidationError(`role must be "target" or "reference", got "${role}"`);
  }
  const canonical = await canonicalRepoRoot(exec, input.rawPath);
  const name = deriveRepoName(canonical);

  if (input.existing.some(e => e.name === name)) {
    throw new DuplicateRepoError(name);
  }
  if (input.existing.some(e => resolve(e.sourcePath) === canonical)) {
    throw new DuplicateCanonicalPathError(canonical);
  }

  return { name, role, sourcePath: canonical };
}

/**
 * Return a porcelain status. Empty string = clean.
 */
export async function repoStatusPorcelain(
  exec: ExecFn,
  repoPath: string,
): Promise<string> {
  const r = await exec(
    "git",
    ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repoPath },
  );
  if (r.code !== 0) {
    throw new RepoValidationError(`git status failed for ${repoPath}`);
  }
  return r.stdout;
}

export interface DirtyCheckResult {
  clean: boolean;
  summary: string;
}

/**
 * Strict: empty porcelain status = clean.
 */
export async function isRepoClean(
  exec: ExecFn,
  repoPath: string,
): Promise<DirtyCheckResult> {
  const out = await repoStatusPorcelain(exec, repoPath);
  const summary = out.replace(/\0/g, "\n").trim();
  return { clean: summary.length === 0, summary };
}

export async function repoHeadSha(exec: ExecFn, repoPath: string): Promise<string> {
  const r = await exec("git", ["-C", repoPath, "rev-parse", "HEAD"]);
  if (r.code !== 0) throw new RepoValidationError(`git rev-parse HEAD failed for ${repoPath}`);
  return r.stdout.trim();
}

export async function branchExists(
  exec: ExecFn,
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const r = await exec(
    "git",
    ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
  );
  return r.code === 0;
}

export async function worktreeListContains(
  exec: ExecFn,
  repoPath: string,
  wtPath: string,
): Promise<boolean> {
  const r = await exec("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (r.code !== 0) return false;
  return r.stdout
    .split("\n")
    .some(line => line.startsWith("worktree ") && line.slice("worktree ".length).trim() === wtPath);
}

export interface CreateWorktreeInput {
  repoPath: string;
  worktreeDir: string;
  /** Branch name to create, or undefined for detached HEAD. */
  branch?: string;
  baseSha: string;
}

export class WorktreeCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeCreationError";
  }
}

/**
 * Create a worktree. Idempotent: if `worktreeDir` already exists and is a
 * valid worktree of `repoPath` pointing at `branch` with HEAD == `baseSha`,
 * returns without mutation. Fails loudly if the directory exists but is
 * not a valid worktree of this repo (so we never silently overwrite state).
 */
export async function createWorktree(
  exec: ExecFn,
  input: CreateWorktreeInput,
): Promise<{ created: boolean; headSha: string }> {
  const { repoPath, worktreeDir: dir, branch, baseSha } = input;

  if (existsSync(dir)) {
    // Validate existing worktree — accept if HEAD matches.
    const headR = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (headR.code !== 0) {
      throw new WorktreeCreationError(
        `worktree dir exists but git rev-parse HEAD failed: ${dir}`,
      );
    }
    const existingHead = headR.stdout.trim();
    if (existingHead !== baseSha) {
      throw new WorktreeCreationError(
        `existing worktree HEAD (${existingHead}) != expected baseSha (${baseSha})`,
      );
    }
    // If branch is specified, verify the worktree is on that branch.
    if (branch) {
      const branchR = await exec("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
      const existingBranch = branchR.code === 0 ? branchR.stdout.trim() : "";
      if (existingBranch !== branch) {
        throw new WorktreeCreationError(
          `existing worktree is on branch "${existingBranch}", expected "${branch}"`,
        );
      }
    }
    return { created: false, headSha: existingHead };
  }

  if (branch) {
    // branch must not exist out-of-band for this creation
    if (await branchExists(exec, repoPath, branch)) {
      throw new WorktreeCreationError(
        `branch "${branch}" already exists in ${repoPath} but no recorded worktree`,
      );
    }
  }

  await mkdir(resolve(dir, ".."), { recursive: true });
  const r = await exec(
    "git",
    ["-C", repoPath, "worktree", "add", ...(branch ? ["-b", branch] : []), dir, baseSha],
  );
  if (r.code !== 0) {
    throw new WorktreeCreationError(
      `git worktree add failed for ${dir}: ${r.stderr || r.stdout}`,
    );
  }
  const head = await repoHeadSha(exec, dir);
  return { created: true, headSha: head };
}


/**
 * Build the canonical `~/.omp/tasks/<id>/worktrees/<repoName>` path. The
 * spec mandates this exact location — never a repo-local worktree dir.
 */
export function worktreeRootFor(taskId: string, repoName: string): string {
  return worktreePath(taskId, repoName);
}

export interface DiffSummaryLine {
  insertions: number;
  deletions: number;
  files: number;
}

/**
 * Quick numstat-based diff summary against a base SHA. Files with binary
 * content contribute 0/0 but count as a changed file.
 */
export async function diffSummaryAgainst(
  exec: ExecFn,
  repoPath: string,
  baseSha: string,
): Promise<DiffSummaryLine> {
  const r = await exec(
    "git",
    ["-C", repoPath, "diff", "--numstat", "--binary", `${baseSha}`],
    { cwd: repoPath },
  );
  if (r.code !== 0) {
    throw new RepoValidationError(`git diff --numstat failed for ${repoPath}`);
  }
  let insertions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    files++;
    if (parts[0] !== "-" && parts[0] !== "") insertions += Number(parts[0]) || 0;
    if (parts[1] !== "-" && parts[1] !== "") deletions += Number(parts[1]) || 0;
  }
  // §27 Fix 4 — untracked files are real implementation changes.
  try {
    // git diff <baseSha> only covers tracked files.
    // Use porcelain with -z (NUL-terminated) to get untracked counts.
    const statusOut = await exec(
      "git",
      ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoPath },
    );
    if (statusOut.code === 0) {
      const chunks = statusOut.stdout.split("\0");
      for (const ch of chunks) {
        if (ch.startsWith("?? ")) {
          files++;
        }
      }
    }
    // Non-zero code or parsing failure — silently keep tracked-only results.
  } catch {}
  return { insertions, deletions, files };
}

export async function isWorkingTreeClean(
  exec: ExecFn,
  repoPath: string,
): Promise<boolean> {
  const r = await isRepoClean(exec, repoPath);
  return r.clean;
}

// re-export so callers don't need a separate import for ExecFn type
export type { ExecFn };

