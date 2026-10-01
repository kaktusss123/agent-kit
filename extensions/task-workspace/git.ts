/**
 * task-workspace core — path classification, git facts, workspace scanning.
 *
 * Host-independent: node/fs + git CLI only. Every function that depends on
 * the task workspace root receives it explicitly; no host-specific default
 * or environment lookup lives here.
 */
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Readable } from "node:stream";
import type {
  DirtyState,
  InputRepoFacts,
  LinkedWorktreeFact,
  ManagedRepoStatus,
  PathClassification,
} from "./types";

function streamText(stream: Readable): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  stream.on("error", reject);
  return promise;
}

// Host-neutral git runner: node child_process (works under Bun and Node),
// async so long operations (fetch) never block the host event loop.
export async function git(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = spawn("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = Promise.withResolvers<number>();
  proc.on("error", exited.reject);
  proc.on("close", (code) => exited.resolve(code ?? -1));
  const [stdout, stderr, exitCode] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    exited.promise,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}



export function expandPath(p: string, cwd: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (!p.startsWith("/")) return join(cwd, p);
  return p;
}


export function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet — walk up to first existing parent and rejoin
    const parts = p.split("/");
    let existing = "";
    for (const part of parts) {
      if (!part) { existing = "/"; continue; }
      const candidate = existing + part;
      try {
        existing = realpathSync(candidate);
      } catch {
        existing = candidate;
      }
      existing += "/";
    }
    return existing.length > 1 ? existing.slice(0, -1) : "/";
  }
}


export function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}


export function isLinkedWorktree(repoRoot: string): boolean {
  try {
    const content = readFileSync(join(repoRoot, ".git"), "utf-8");
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}


export function underTaskRoot(p: string, taskRoot: string): boolean {
  return p.startsWith(taskRoot + "/") || p === taskRoot;
}


const TEMPORARY_ROOT_RE = /^\/(?:private\/)?tmp(?:\/|$)/;

export function isTemporaryPath(p: string): boolean {
  return TEMPORARY_ROOT_RE.test(realpath(p));
}

export function isGitMetadataPath(root: string, target: string): boolean {
  const gitDir = join(root, ".git");
  return target === gitDir || target.startsWith(gitDir + "/");
}
function hasSymlinkComponent(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../")) return true;
  let current = root;
  for (const part of rel.split("/")) {
    if (!part) continue;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // Missing path components cannot contain a symlink at this point.
      break;
    }
  }
  return false;
}


function literalPathspec(root: string, target: string): string {
  return `./${relative(root, target)}`;
}
// check-ignore rejects the global --literal-pathspecs option, so prefixing the
// path with ./ prevents a leading :(...) from being parsed as pathspec magic.

function isTrackedPath(root: string, target: string): boolean {
  const proc = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "-C",
      root,
      "ls-files",
      "--error-unmatch",
      "--",
      literalPathspec(root, target),
    ],
    { encoding: "utf8" },
  );
  return proc.status === 0;
}

function isGitIgnoredPath(root: string, target: string): boolean {
  const proc = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--quiet", "--no-index", "--", literalPathspec(root, target)],
    { encoding: "utf8" },
  );
  // Only Git's explicit "ignored" result authorizes the escape hatch.
  // Errors and non-ignored paths remain blocked.
  return proc.status === 0;
}

export function isAllowedIgnoredPrimaryPath(root: string, target: string): boolean {
  if (isGitMetadataPath(root, target)) return false;
  if (hasSymlinkComponent(root, target)) return false;
  if (isTrackedPath(root, target)) return false;
  return isGitIgnoredPath(root, target);
}


export function classifyPath(p: string, cwd: string, taskRoot: string): PathClassification {
  const expanded = expandPath(p, cwd);
  let abs = expanded;
  try {
    abs = realpath(expanded);
  } catch {
    // Target may not exist yet (e.g. a brand-new file); classify the
    // expanded path instead of throwing out of a guard.
  }
  const root = findGitRoot(abs);
  if (!root) return "OUTSIDE_GIT";
  if (underTaskRoot(root, taskRoot)) return "MANAGED_TASK_WORKTREE";
  if (isLinkedWorktree(root)) return "OTHER_LINKED_WORKTREE";
  return "PRIMARY_CHECKOUT";
}



export async function getRepoBranch(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "branch", "--show-current");
  return r.ok ? r.stdout : "";
}

/** Explicit HEAD facts for projections that must not fake a branch: detached
 *  HEAD is reported directly, and a failed read is `available: false` so
 *  callers never render an unknown state as a clean known one. `branch` is
 *  empty on detached HEAD and whenever the read failed. */
export interface HeadFacts {
  available: boolean;
  branch: string;
  detached: boolean;
  sha: string | null;
}

export async function getHeadFacts(repoRoot: string): Promise<HeadFacts> {
  const abbrev = await git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
  const sha = await git(repoRoot, "rev-parse", "HEAD");
  const available = abbrev.ok && sha.ok;
  const detached = available && abbrev.stdout === "HEAD";
  return {
    available,
    branch: available && !detached ? abbrev.stdout : "",
    detached,
    sha: available ? sha.stdout : null,
  };
}

export async function getRepoSha(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "rev-parse", "HEAD");
  return r.ok ? r.stdout : "";
}
export async function getUpstream(repoRoot: string, branch: string): Promise<string | null> {
  const r = await git(
    repoRoot,
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  );
  const out = r.ok ? r.stdout.trim() : "";
  return out || null;
}

export async function getSourceDirty(
  sourceRoot: string,
): Promise<DirtyState> {
  // porcelain v2: lines start with a token ("1 ", "? "), never a bare status
  // column — immune to the whitespace-trimming inside git().
  const r = await git(sourceRoot, "status", "--porcelain=v2", "--no-renames");
  if (!r.ok) return { staged: [], unstaged: [] };
  return parseDirtyStatus(r.stdout);
}

/** Parse `git status --porcelain=v2 --no-renames` output; the single
 *  definition of the dirty-state shape (staged = index differs from HEAD,
 *  unstaged = worktree/index differs, untracked counts as unstaged; lists
 *  are capped). Trailing "\t<origPath>" rename fields cannot occur because
 *  --no-renames is always passed with this format. */
export function parseDirtyStatus(stdout: string): DirtyState {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const push = (xy: string, path: string): void => {
    if (xy[0] !== ".") staged.push(path);
    if (xy[1] !== ".") unstaged.push(path);
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("? ")) {
      // Untracked files are dirt too — the typical manual-change case.
      unstaged.push(line.slice(2));
      continue;
    }
    if (line.startsWith("! ")) continue; // ignored files are not dirt
    // "1 XY sub mH mI mW hH hI <path>" / "u XY sub m1 m2 m3 mW h1 h2 h3 <path>"
    const fields = line.split(" ");
    if (fields[0] === "1" && fields.length >= 9) {
      push(fields[1]!, fields.slice(8).join(" "));
    } else if (fields[0] === "u" && fields.length >= 11) {
      push(fields[1]!, fields.slice(10).join(" "));
    }
  }
  return {
    staged: staged.slice(0, 50),
    unstaged: unstaged.slice(0, 50),
  };
}


export async function getInputRepoFacts(
  inputPath: string,
  gitRoot: string,
  cwd: string,
  taskRoot: string,
): Promise<InputRepoFacts> {
  return {
    inputPath,
    gitRoot,
    classification: classifyPath(inputPath, cwd, taskRoot),
    branch: await getRepoBranch(gitRoot),
    headSha: await getRepoSha(gitRoot),
    dirty: await getSourceDirty(gitRoot),
  };
}


export function taskWorkspacePath(task: string, taskRoot: string): string {
  return join(taskRoot, task.replace(/\//g, "_"));
}

export function parseWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export interface WorktreeListEntry {
  path: string;
  head: string;
  /** Checked-out local branch (short name), or null when detached. */
  branch: string | null;
}

/** Parsed `git worktree list --porcelain`; empty when the repo dir cannot
 *  be read (callers treat that as a refusal, not as "no worktrees"). */
export async function getWorktreeList(repoDir: string): Promise<WorktreeListEntry[]> {
  const r = await git(repoDir, "worktree", "list", "--porcelain");
  if (!r.ok) return [];
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), head: "", branch: null };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
  }
  if (current) entries.push(current);
  return entries;
}


export async function getRepoCommonDir(repoRoot: string): Promise<string | null> {
  const result = await git(repoRoot, "rev-parse", "--git-common-dir");
  return result.ok && result.stdout
    ? realpath(resolve(repoRoot, result.stdout))
    : null;
}

export function parseLaneName(name: string): { repo: string; slot: string } | null {
  const marker = name.lastIndexOf("__");
  if (marker <= 0 || marker === name.length - 2) return null;
  return { repo: name.slice(0, marker), slot: name.slice(marker + 2) };
}

export function laneIdentity(
  name: string,
  linked: Map<string, LinkedWorktreeFact>,
): {
  kind: "canonical" | "lane";
  slot: string | null;
  repo: string;
} {
  const parsed = parseLaneName(name);
  const current = linked.get(name);
  const canonical = parsed ? linked.get(parsed.repo) : undefined;
  if (
    parsed &&
    current?.commonDir &&
    canonical?.commonDir &&
    current.commonDir === canonical.commonDir
  ) {
    return { kind: "lane", slot: parsed.slot, repo: parsed.repo };
  }
  return { kind: "canonical", slot: null, repo: name };
}
export async function getLaneFacts(
  task: string,
  path: string,
  slot: string,
  repo: string,
): Promise<{
  task: string;
  repo: string;
  slot: string;
  path: string;
  branch: string;
  headSha: string;
  upstream: string | null;
  dirty: DirtyState;
}> {
  const branch = await getRepoBranch(path);
  return {
    task,
    repo,
    slot,
    path,
    branch,
    headSha: await getRepoSha(path),
    upstream: await getUpstream(path, branch),
    dirty: await getSourceDirty(path),
  };
}



/** Linked worktrees directly inside one workspace directory: entries whose
 *  `.git` is a gitdir pointer file, with their resolved common dir. The
 *  single repo-set definition shared by the global catalog scan
 *  (scanTaskWorkspaces) and the single-workspace current-task projection
 *  (readWorkspaceRepos in ./current). */
export async function linkedWorktreeFacts(
  wsPath: string,
  options: { strict?: boolean } = {},
): Promise<{ name: string; path: string; commonDir: string | null }[]> {
  let subEntries: string[];
  try {
    subEntries = await readdir(wsPath);
  } catch (error) {
    if (!options.strict || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const facts: { name: string; path: string; commonDir: string | null }[] = [];
  for (const sub of subEntries) {
    const subPath = join(wsPath, sub);
    let gitContent: string;
    try {
      gitContent = readFileSync(join(subPath, ".git"), "utf-8");
    } catch (error) {
      if (!options.strict || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!gitContent.startsWith("gitdir:")) continue;
    try {
      facts.push({
        name: sub,
        path: subPath,
        commonDir: await getRepoCommonDir(subPath),
      });
    } catch (error) {
      if (options.strict) throw error;
    }
  }
  return facts;
}

export async function scanTaskWorkspaces(taskRoot: string): Promise<
  {
    workspace: string;
    key: string;
    task: string;
    repos: ManagedRepoStatus[];
    artifacts: string[];
  }[]
> {
  const workspaces: {
    workspace: string;
    key: string;
    task: string;
    repos: ManagedRepoStatus[];
    artifacts: string[];
  }[] = [];

  let entries: string[];
  try {
    entries = await readdir(taskRoot);
  } catch {
    return workspaces;
  }

  for (const entry of entries) {
    const wsPath = join(taskRoot, entry);

    const linkedList = await linkedWorktreeFacts(wsPath);
    const linked = new Map<string, LinkedWorktreeFact>(
      linkedList.map((f) => [f.name, { path: f.path, commonDir: f.commonDir }]),
    );

    const repos: ManagedRepoStatus[] = [];
    for (const [sub, worktree] of linked) {
      const identity = laneIdentity(sub, linked);
      const branch = await getRepoBranch(worktree.path);
      repos.push({
        name: sub,
        path: worktree.path,
        kind: identity.kind,
        slot: identity.slot,
        classification: "MANAGED_TASK_WORKTREE",
        branch,
        headSha: await getRepoSha(worktree.path),
        upstream: await getUpstream(worktree.path, branch),
        dirty: await getSourceDirty(worktree.path),
      });
    }

    if (repos.length === 0) continue;

    const artifacts: string[] = [];
    try {
      const files = await readdir(wsPath);
      for (const f of files) {
        if (f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".txt")) {
          artifacts.push(f);
        }
      }
    } catch {
      // workspace dir may not be readable
    }

    workspaces.push({
      workspace: wsPath,
      key: entry,
      task: entry,
      repos,
      artifacts,
    });
  }

  return workspaces;
}



/** Managed worktrees of the SAME repository that a blocked primary-checkout
 *  mutation should be redirected to: all of them when several exist, none
 *  invented when there are none. */
export function managedWorktreeHint(root: string, taskRoot: string): string | null {
  const proc = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return null;
  const managed: string[] = [];
  for (const line of proc.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (underTaskRoot(wt, taskRoot)) managed.push(wt);
  }
  if (managed.length === 0) return null;
  if (managed.length === 1) return managed[0];
  const shown = managed.slice(0, 8).join("\n  ");
  return `\n  ${shown}${managed.length > 8 ? `\n  … (${managed.length} managed worktrees total)` : ""}`;
}

