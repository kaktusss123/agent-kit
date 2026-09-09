/**
 * task-workspace — Deterministic task-workspace runtime.
 *
 * Manages git worktrees for multi-repo task isolation.
 * Branch = task identity. Workspace root = ~/.omp/tasks/<branch_flat>/.
 * All state lives in git (branches + worktrees); no manifest files.
 *
 * Residual limitation (accepted by design): flattening a branch name into the
 * workspace directory name is not injective — distinct branch identities can
 * produce the same directory. No manifest or naming migration exists; resolve
 * a real collision manually if one ever materializes.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { join, basename, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readdir } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";

// Configurable root (env override for tests)
const TASK_ROOT = realpath(process.env.OMP_TASK_ROOT ?? join(homedir(), ".omp", "tasks"));

// ─── Git helpers ────────────────────────────────────────────────────────

async function git(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Path classification ────────────────────────────────────────────────

type PathClassification =
  | "OUTSIDE_GIT"
  | "PRIMARY_CHECKOUT"
  | "MANAGED_TASK_WORKTREE"
  | "OTHER_LINKED_WORKTREE";

function expandPath(p: string, cwd: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (!p.startsWith("/")) return join(cwd, p);
  return p;
}

function realpath(p: string): string {
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

function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function isLinkedWorktree(repoRoot: string): boolean {
  try {
    const content = readFileSync(join(repoRoot, ".git"), "utf-8");
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}

function underTaskRoot(p: string): boolean {
  return p.startsWith(TASK_ROOT + "/") || p === TASK_ROOT;
}

const TEMPORARY_ROOT_RE = /^\/(?:private\/)?tmp(?:\/|$)/;

function isTemporaryPath(p: string): boolean {
  return TEMPORARY_ROOT_RE.test(realpath(p));
}

function hasTemporaryShellCwd(command: string): boolean {
  return /(?:^|[;&|]\s*)cd\s+(?:"|')?\/(?:private\/)?tmp(?:\/|(?=["'\s;&|]|$))/.test(command);
}

function isGitMetadataPath(root: string, target: string): boolean {
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
  const proc = Bun.spawnSync([
    "git",
    "--literal-pathspecs",
    "-C",
    root,
    "ls-files",
    "--error-unmatch",
    "--",
    literalPathspec(root, target),
  ]);
  return proc.exitCode === 0;
}

function isGitIgnoredPath(root: string, target: string): boolean {
  const proc = Bun.spawnSync([
    "git",
    "-C",
    root,
    "check-ignore",
    "--quiet",
    "--no-index",
    "--",
    literalPathspec(root, target),
  ]);
  // Only Git's explicit "ignored" result authorizes the escape hatch.
  // Errors and non-ignored paths remain blocked.
  return proc.exitCode === 0;
}

function isAllowedIgnoredPrimaryPath(root: string, target: string): boolean {
  if (isGitMetadataPath(root, target)) return false;
  if (hasSymlinkComponent(root, target)) return false;
  if (isTrackedPath(root, target)) return false;
  return isGitIgnoredPath(root, target);
}


function classifyPath(p: string, cwd: string): PathClassification {
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
  if (underTaskRoot(root)) return "MANAGED_TASK_WORKTREE";
  if (isLinkedWorktree(root)) return "OTHER_LINKED_WORKTREE";
  return "PRIMARY_CHECKOUT";
}

// ─── Git data helpers ───────────────────────────────────────────────────

async function getRepoBranch(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "branch", "--show-current");
  return r.ok ? r.stdout : "";
}

async function getRepoSha(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, "rev-parse", "HEAD");
  return r.ok ? r.stdout : "";
}
async function getUpstream(repoRoot: string, branch: string): Promise<string | null> {
  const r = await git(
    repoRoot,
    "for-each-ref",
    "--format=%(upstream:short)",
    `refs/heads/${branch}`,
  );
  const out = r.ok ? r.stdout.trim() : "";
  return out || null;
}

async function getSourceDirty(
  sourceRoot: string,
): Promise<{ staged: string[]; unstaged: string[] }> {
  const r = await git(sourceRoot, "status", "--porcelain=v1");
  if (!r.ok) return { staged: [], unstaged: [] };
  const staged: string[] = [];
  const unstaged: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const indexStatus = line[0];
    const workStatus = line[1];
    const path = line.slice(3);
    if (indexStatus !== " " && indexStatus !== "?") staged.push(path);
    // Untracked files ("??") are source dirt too — the typical manual-change case.
    if (workStatus !== " ") unstaged.push(path);
  }
  return {
    staged: staged.slice(0, 50),
    unstaged: unstaged.slice(0, 50),
  };
}
type DirtyState = { staged: string[]; unstaged: string[] };

interface InputRepoFacts {
  inputPath: string;
  gitRoot: string;
  classification: PathClassification;
  branch: string;
  headSha: string;
  dirty: DirtyState;
}

async function getInputRepoFacts(
  inputPath: string,
  gitRoot: string,
  cwd: string,
): Promise<InputRepoFacts> {
  return {
    inputPath,
    gitRoot,
    classification: classifyPath(inputPath, cwd),
    branch: await getRepoBranch(gitRoot),
    headSha: await getRepoSha(gitRoot),
    dirty: await getSourceDirty(gitRoot),
  };
}

function taskWorkspacePath(task: string): string {
  return join(TASK_ROOT, task.replace(/\//g, "_"));
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

type LinkedWorktreeFact = {
  path: string;
  commonDir: string | null;
};

async function getRepoCommonDir(repoRoot: string): Promise<string | null> {
  const result = await git(repoRoot, "rev-parse", "--git-common-dir");
  return result.ok && result.stdout
    ? realpath(resolve(repoRoot, result.stdout))
    : null;
}

function parseLaneName(name: string): { repo: string; slot: string } | null {
  const marker = name.lastIndexOf("__");
  if (marker <= 0 || marker === name.length - 2) return null;
  return { repo: name.slice(0, marker), slot: name.slice(marker + 2) };
}

function laneIdentity(
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
async function getLaneFacts(
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



// ─── Worktree scanning ──────────────────────────────────────────────────

type ManagedRepoStatus = {
  name: string;
  path: string;
  kind: "canonical" | "lane";
  slot: string | null;
  classification: "MANAGED_TASK_WORKTREE";
  branch: string;
  headSha: string;
  upstream: string | null;
  dirty: DirtyState;
};

async function scanTaskWorkspaces(): Promise<
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
    entries = await readdir(TASK_ROOT);
  } catch {
    return workspaces;
  }

  for (const entry of entries) {
    const wsPath = join(TASK_ROOT, entry);
    let subEntries: string[];
    try {
      subEntries = await readdir(wsPath);
    } catch {
      continue;
    }

    const linked = new Map<string, LinkedWorktreeFact>();
    for (const sub of subEntries) {
      const subPath = join(wsPath, sub);
      try {
        const gitContent = readFileSync(join(subPath, ".git"), "utf-8");
        if (!gitContent.startsWith("gitdir:")) continue;
        linked.set(sub, {
          path: subPath,
          commonDir: await getRepoCommonDir(subPath),
        });
      } catch {
        continue;
      }
    }

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

type GitOperationClass =
  | "read-only"
  | "safe-refresh"
  | "local/ref-mutation"
  | "external-side-effect"
  | "ambiguous";

interface ParsedGitInvocation {
  subcommand: string;
  repoRef: string | null; // -C <path> target, or null for the session cwd
  operationClass: GitOperationClass;
  mutating: boolean;
  noVerify: boolean;
}

/** git flags that consume the next token as their value. */
const GIT_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--super-prefix": true,
};

const READ_ONLY_GIT_SUBCOMMANDS: Record<string, true> = {
  "cat-file": true,
  describe: true,
  diff: true,
  "for-each-ref": true,
  log: true,
  "ls-files": true,
  "ls-tree": true,
  "rev-parse": true,
  show: true,
  "show-ref": true,
  status: true,
};

const LOCAL_MUTATION_GIT_SUBCOMMANDS: Record<string, true> = {
  add: true,
  checkout: true,
  "cherry-pick": true,
  clean: true,
  commit: true,
  merge: true,
  rebase: true,
  reset: true,
  restore: true,
  switch: true,
};

const BRANCH_READ_ONLY_FLAGS: Record<string, true> = {
  "--all": true,
  "--contains": true,
  "--format": true,
  "--list": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--remotes": true,
  "--show-current": true,
  "--sort": true,
  "--verbose": true,
  "--column": true,
  "-a": true,
  "-l": true,
  "-r": true,
  "-v": true,
  "-vv": true,
  "-n": true,
};

const BRANCH_MUTATION_FLAGS: Record<string, true> = {
  "--copy": true,
  "--delete": true,
  "--edit-description": true,
  "--move": true,
  "--set-upstream-to": true,
  "--track": true,
  "--unset-upstream": true,
  "-c": true,
  "-C": true,
  "-d": true,
  "-D": true,
  "-m": true,
  "-M": true,
};

const TAG_READ_ONLY_FLAGS: Record<string, true> = {
  "--contains": true,
  "--format": true,
  "--list": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "--column": true,
  "--verify": true,
  "-l": true,
  "-n": true,
  "-v": true,
};

const TAG_MUTATION_FLAGS: Record<string, true> = {
  "--annotate": true,
  "--create-reflog": true,
  "--delete": true,
  "--force": true,
  "--local-user": true,
  "--message": true,
  "--sign": true,
  "--cleanup": true,
  "-a": true,
  "-d": true,
  "-f": true,
  "-m": true,
  "-s": true,
};
const READ_ONLY_VALUE_FLAGS: Record<string, true> = {
  "--contains": true,
  "--format": true,
  "--merged": true,
  "--no-merged": true,
  "--points-at": true,
  "--sort": true,
  "-n": true,
};


function unquoteToken(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function flagName(token: string): string {
  return unquoteToken(token).split("=", 1)[0];
}
function consumesSeparateValue(token: string, flag: string): boolean {
  return READ_ONLY_VALUE_FLAGS[flag] === true && !token.includes("=");
}

function classifyBranchOperation(rest: string[]): GitOperationClass {
  let readMode = false;
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (BRANCH_MUTATION_FLAGS[flag] === true || flag === "--force") {
      return "local/ref-mutation";
    }
    if (BRANCH_READ_ONLY_FLAGS[flag] === true) {
      readMode = true;
      if (consumesSeparateValue(token, flag)) i++;
      continue;
    }
    if (token.startsWith("-")) return "ambiguous";
    if (!readMode) return "local/ref-mutation";
  }
  return "read-only";
}

function classifyTagOperation(rest: string[]): GitOperationClass {
  let readMode = false;
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (TAG_MUTATION_FLAGS[flag] === true) return "local/ref-mutation";
    if (TAG_READ_ONLY_FLAGS[flag] === true) {
      readMode = true;
      if (consumesSeparateValue(token, flag)) i++;
      continue;
    }
    if (token.startsWith("-")) return "ambiguous";
    if (!readMode) return "local/ref-mutation";
  }
  return "read-only";
}

function classifyRemoteOperation(rest: string[]): GitOperationClass {
  const first = rest[0] ? unquoteToken(rest[0]) : "";
  if (
    first === "" ||
    first === "-v" ||
    first === "--verbose" ||
    first === "get-url" ||
    first === "get-branches" ||
    first === "show"
  ) {
    return "read-only";
  }
  return "local/ref-mutation";
}
const FETCH_VALUE_FLAGS: Record<string, true> = {
  "--depth": true,
  "--filter": true,
  "--negotiation-tip": true,
  "--server-option": true,
  "--shallow-exclude": true,
  "--shallow-since": true,
  "--upload-pack": true,
};

function classifyFetchRefspec(refspec: string): GitOperationClass {
  const separator = refspec.indexOf(":");
  if (separator === -1) return "ambiguous";
  const destination = refspec.slice(separator + 1);
  return destination.startsWith("refs/heads/")
    ? "local/ref-mutation"
    : "ambiguous";
}

function classifyFetchOperation(rest: string[]): GitOperationClass {
  for (let i = 0; i < rest.length; i++) {
    const token = unquoteToken(rest[i]);
    const flag = flagName(token);
    if (flag === "--stdin") return "ambiguous";
    if (flag === "-P" || flag === "--prune-tags") {
      return "local/ref-mutation";
    }
    if (flag === "--refmap") {
      const refspec = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : rest[++i];
      if (refspec === undefined) return "ambiguous";
      return classifyFetchRefspec(unquoteToken(refspec));
    }
    if (token.startsWith("-")) {
      if (
        FETCH_VALUE_FLAGS[flag] === true &&
        !token.includes("=")
      ) {
        i++;
      }
      continue;
    }

    if (token.includes(":")) return classifyFetchRefspec(token);
  }
  return "safe-refresh";
}

/** Conservative scan of EVERY `git` invocation in a (possibly compound) shell
 * command. It is not a shell interpreter: ambiguous input errs toward
 * local/ref-mutation so the guard fails closed. */
function parseGitInvocations(command: string): ParsedGitInvocation[] {
  const invocations: ParsedGitInvocation[] = [];
  const gitWord = /(^|[\s;&|(`])git(?=$|[\s;&|(`])/g;
  let m: RegExpExecArray | null;

  while ((m = gitWord.exec(command)) !== null) {
    const tokens: string[] = [];
    let i = m.index + m[0].length;
    while (i < command.length) {
      while (i < command.length && /\s/.test(command[i])) i++;
      if (i >= command.length) break;
      const ch = command[i];
      if (";&|()`".includes(ch)) break;
      if (ch === '"' || ch === "'") {
        const close = command.indexOf(ch, i + 1);
        const end = close === -1 ? command.length : close + 1;
        tokens.push(command.slice(i, end));
        i = end;
      } else {
        let j = i;
        while (j < command.length && !/[\s;&|()`]/.test(command[j])) j++;
        tokens.push(command.slice(i, j));
        i = j;
      }
    }
    invocations.push(parseGitTokens(tokens));
    gitWord.lastIndex = i;
  }
  return invocations;
}

function parseGitTokens(tokens: string[]): ParsedGitInvocation {
  const inv: ParsedGitInvocation = {
    subcommand: "",
    repoRef: null,
    operationClass: "ambiguous",
    mutating: true,
    noVerify: false,
  };
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i];
    if (flag.includes("=")) {
      i++;
      continue;
    }
    if (GIT_VALUE_FLAGS[flag] === true) {
      const value = tokens[i + 1];
      if (value === undefined) return inv;
      if (flag === "-C") inv.repoRef = value;
      i += 2;
      continue;
    }
    i++;
  }
  inv.subcommand = unquoteToken(tokens[i] ?? "");
  const rest = tokens.slice(i + 1);
  if (inv.subcommand === "branch") {
    inv.operationClass = classifyBranchOperation(rest);
  } else if (inv.subcommand === "tag") {
    inv.operationClass = classifyTagOperation(rest);
  } else if (inv.subcommand === "worktree") {
    const first = rest[0] ? flagName(rest[0]) : "";
    inv.operationClass =
      first === "list" || first === "show" ? "read-only" : "local/ref-mutation";
  } else if (inv.subcommand === "fetch") {
    inv.operationClass = classifyFetchOperation(rest);
  } else if (inv.subcommand === "push") {
    inv.operationClass = "external-side-effect";
  } else if (inv.subcommand === "update-ref") {
    inv.operationClass = "local/ref-mutation";
  } else if (inv.subcommand === "remote") {
    inv.operationClass = classifyRemoteOperation(rest);
  } else if (READ_ONLY_GIT_SUBCOMMANDS[inv.subcommand] === true) {
    inv.operationClass = "read-only";
  } else if (LOCAL_MUTATION_GIT_SUBCOMMANDS[inv.subcommand] === true) {
    inv.operationClass = "local/ref-mutation";
  }
  inv.mutating =
    inv.operationClass === "local/ref-mutation" ||
    inv.operationClass === "ambiguous";
  inv.noVerify =
    rest.some((t) => unquoteToken(t) === "--no-verify") ||
    (inv.subcommand === "commit" &&
      rest.some((t) => unquoteToken(t) === "-n"));
  return inv;
}
const DEFERRED_PASS_RESULTS: Record<string, true> = {
  pass: true,
  passed: true,
  ok: true,
  success: true,
  successful: true,
  true: true,
  yes: true,
};

/** Internal-URL targets are session resources, never filesystem paths. */
const INTERNAL_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;


/** Managed worktrees of the SAME repository that a blocked primary-checkout
 *  mutation should be redirected to: all of them when several exist, none
 *  invented when there are none. */
function managedWorktreeHint(root: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", root, "worktree", "list", "--porcelain"]);
  if (proc.exitCode !== 0) return null;
  const managed: string[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (underTaskRoot(wt)) managed.push(wt);
  }
  if (managed.length === 0) return null;
  if (managed.length === 1) return managed[0];
  const shown = managed.slice(0, 8).join("\n  ");
  return `\n  ${shown}${managed.length > 8 ? `\n  … (${managed.length} managed worktrees total)` : ""}`;
}

// ─── Secret path detection ──────────────────────────────────────────────

const SECRET_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

function isSecretPath(filePath: string): boolean {
  const base = basename(filePath);
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (/\.(pem|key)$/.test(base)) return true;
  if (/credentials/.test(base)) return true;
  if (/^secrets\./.test(base)) return true;
  return false;
}

// ─── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const tb = pi.typebox.Type;

  // ─── task_status ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description:
      "Classify the current path and report current Git facts; list each managed task workspace with canonical-or-lane kind, slot, path, branch, HEAD, upstream, classification, dirty paths, and artifacts.",
    parameters: tb.Object({
      path: tb.Optional(
        tb.String({ description: "Path to classify (defaults to session cwd)" }),
      ),
    }),
    approval: "read",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const cwd = realpath(ctx.cwd);
        const targetPath = params.path ? expandPath(params.path, cwd) : cwd;
        const classification = classifyPath(targetPath, cwd);

        let repoRoot = "";
        let branch = "";
        let isLinked = false;
        if (classification !== "OUTSIDE_GIT") {
          const abs = expandPath(targetPath, cwd);
          const root = findGitRoot(abs);
          if (root) {
            repoRoot = root;
            branch = await getRepoBranch(root);
            isLinked = isLinkedWorktree(root);
          }
        }

        const taskWorkspaces = await scanTaskWorkspaces();

        const result = {
          classification,
          cwd: targetPath,
          repoRoot,
          branch,
          isLinkedWorktree: isLinked,
          taskRoot: TASK_ROOT,
          taskWorkspaces,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message: (e as Error).message }),
            },
          ],
        };
      }
    },
  });

  // ─── ensure_task_repo ────────────────────────────────────────────────
  pi.registerTool({
    name: "ensure_task_repo",
    label: "Ensure Task Repo",
    description:
      "Attach a source repo to the task workspace as a git worktree. Results identify the task, canonical-or-lane kind, slot, target worktree, branch/base provenance, upstream, and the exact inputRepo checkout facts. Reuses existing worktrees, creates new ones from local/remote branches, or fetches and creates from remote default. Never forces, resets, or detaches.",
    parameters: tb.Object({
      branch: tb.String({
        description:
          "Task branch name. Canonical call: this is the task identity. Lane call (with slot): the lane's own branch.",
      }),
      source_path: tb.String({ description: "Path to the source git repository" }),
      base_ref: tb.Optional(
        tb.String({
          description: "Explicit base ref for new branch creation (e.g. main, develop, HEAD~5)",
        }),
      ),
      remote: tb.Optional(
        tb.String({ description: "Remote name to use (defaults to auto-detect)" }),
      ),
      task: tb.Optional(
        tb.String({
          description:
            "Canonical task identity (workspace name). Required with slot for secondary lanes; ignored otherwise.",
        }),
      ),
      slot: tb.Optional(
        tb.String({
          description:
            "Secondary lane name (e.g. develop-backport). Creates a sibling <repo>__<slot> worktree inside the canonical task workspace with its own branch/base, without creating a second task workspace.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        // 1. Resolve source repo (canonicalize cwd to avoid symlink mismatches)
        const cwd = realpath(_ctx.cwd);
        const sourceAbs = expandPath(params.source_path, cwd);
        const srcRoot = await git(sourceAbs, "rev-parse", "--show-toplevel");
        if (!srcRoot.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Not a git repository: ${params.source_path}`,
                }),
              },
            ],
          };
        }
        const sourceRoot = srcRoot.stdout;

        // 2. Workspace + target path. Canonical call: workspace identity is the
        // branch, target dir is the repo basename. Lane call: same canonical
        // workspace (identity from `task`), sibling dir <repo>__<slot>, and the
        // lane's own `branch`/base — no second task workspace, no manifest.
        if (params.slot && !params.task) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message:
                    "slot requires task (the canonical workspace identity) so the lane lands inside the existing task workspace",
                }),
              },
            ],
          };
        }
        if (
          params.slot &&
          (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.slot) ||
            params.slot.includes("__"))
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: "slot must match [A-Za-z0-9][A-Za-z0-9._-]* and must not contain __",
                }),
              },
            ],
          };
        }
        const identity = params.slot ? params.task : params.branch;
        if (identity === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: "Task identity is required: pass branch, or slot together with task",
                }),
              },
            ],
          };
        }
        const ws = taskWorkspacePath(identity);
        const target = params.slot
          ? join(ws, `${basename(sourceRoot)}__${params.slot}`)
          : join(ws, basename(sourceRoot));

        // 3. Check if target exists but is not a worktree of source
        if (existsSync(target)) {
          const gDir = findGitRoot(target);
          if (gDir) {
            const wtList = await git(sourceRoot, "worktree", "list", "--porcelain");
            if (wtList.ok) {
              const resolvedTarget = realpath(target);
              const isWorktreeOfSource = wtList.stdout
                .split("\n")
                .some(
                  (line) =>
                    line.startsWith("worktree ") &&
                    realpath(line.slice("worktree ".length)) === resolvedTarget,
                );
              if (!isWorktreeOfSource) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        status: "error",
                        message: `Target exists at ${target} but is not a worktree of ${sourceRoot}`,
                      }),
                    },
                  ],
                };
              }
            }
          }
        }

        // 4. Check if target is already managed by source repo
        const wtList = await git(sourceRoot, "worktree", "list", "--porcelain");
        if (wtList.ok) {
          const lines = wtList.stdout.split("\n");
          let currentPath = "";
          let currentBranch = "";
          const resolvedTarget = realpath(target);
          for (const line of lines) {
            if (line.startsWith("worktree ")) {
              if (realpath(currentPath) === resolvedTarget) break;
              currentPath = line.slice("worktree ".length);
              currentBranch = "";
            } else if (line.startsWith("branch ")) {
              currentBranch = line
                .slice("branch ".length)
                .replace("refs/heads/", "");
            }
          }
          if (realpath(currentPath) === resolvedTarget) {
            if (currentBranch === params.branch) {
              const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd);
              const headSha = await getRepoSha(target);
              const upstream = await getUpstream(sourceRoot, params.branch);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "reused",
                      task: identity,
                      worktree: target,
                      kind: params.slot ? "lane" : "canonical",
                      slot: params.slot ?? null,
                      branch: params.branch,
                      branchSource: "local",
                      upstream,
                      base: null,
                      inputRepo,
                      headSha,
                    }),
                  },
                ],
                details: { status: "reused", worktree: target },
              };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Worktree exists at ${target} but on branch ${currentBranch}, not ${params.branch}`,
                  }),
                },
              ],
            };
          }
        }

        // 5. Resolve remote
        let remote = params.remote;
        if (!remote) {
          const remoteList = await git(sourceRoot, "remote");
          if (!remoteList.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: "No remotes configured in source repo",
                  }),
                },
              ],
            };
          }
          const remotes = remoteList.stdout
            .split("\n")
            .filter((r) => r);
          if (remotes.includes("origin")) {
            remote = "origin";
          } else if (remotes.length === 1) {
            remote = remotes[0];
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "remote_selection_required",
                    remotes,
                  }),
                },
              ],
            };
          }
        }

        // 6. Branch resolution
        const localRef = await git(
          sourceRoot,
          "show-ref",
          "--verify",
          `refs/heads/${params.branch}`,
        );
        if (localRef.ok) {
          // Local branch exists — check if it's checked out elsewhere
          const allWt = await git(sourceRoot, "worktree", "list", "--porcelain");
          if (allWt.ok) {
            const wtLines = allWt.stdout.split("\n");
            let wtPath = "";
            let wtBranch = "";
            for (const line of wtLines) {
              if (line.startsWith("worktree ")) {
                if (wtBranch === params.branch && realpath(wtPath) !== realpath(target)) {
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify({
                          status: "branch_in_use",
                          worktree: wtPath,
                        }),
                      },
                    ],
                  };
                }
                wtPath = line.slice("worktree ".length);
                wtBranch = "";
              } else if (line.startsWith("branch ")) {
                wtBranch = line
                  .slice("branch ".length)
                  .replace("refs/heads/", "");
              }
            }
            if (wtBranch === params.branch && realpath(wtPath) !== realpath(target)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "branch_in_use",
                      worktree: wtPath,
                    }),
                  },
                ],
              };
            }
          }

          // Branch is free — create worktree
          await mkdir(ws, { recursive: true });
          const add = await git(
            sourceRoot,
            "worktree",
            "add",
            target,
            params.branch,
          );
          if (!add.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Failed to create worktree: ${add.stderr}`,
                  }),
                },
              ],
            };
          }
          const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd);
          const headSha = await getRepoSha(target);
          const upstream = await getUpstream(sourceRoot, params.branch);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "attached",
                  task: identity,
                  worktree: target,
                  kind: params.slot ? "lane" : "canonical",
                  slot: params.slot ?? null,
                  branch: params.branch,
                  branchSource: "local",
                  upstream,
                  base: null,
                  inputRepo,
                  headSha,
                }),
              },
            ],
            details: { status: "attached", worktree: target },
          };
        }
        // 6b. Local absent — one required successful fetch of the chosen
        // remote, then resolve against the refreshed refs. Fail closed on
        // fetch failure: stale remote refs never materialize a task branch.
        const fetchRes = await git(
          sourceRoot,
          "fetch",
          "--prune",
          "--no-prune-tags",
          remote,
        );
        if (!fetchRes.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Fetch of ${remote} failed; refusing to create task branch from stale refs: ${fetchRes.stderr.trim()}`,
                }),
              },
            ],
          };
        }
        const remoteRef = await git(
          sourceRoot,
          "show-ref",
          "--verify",
          `refs/remotes/${remote}/${params.branch}`,
        );
        if (remoteRef.ok) {
          const remoteSha = remoteRef.stdout.split(/\s+/)[0];
          await mkdir(ws, { recursive: true });
          const add = await git(
            sourceRoot,
            "worktree",
            "add",
            "--track",
            "-b",
            params.branch,
            target,
            `${remote}/${params.branch}`,
          );
          if (!add.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Failed to create worktree from remote: ${add.stderr}`,
                  }),
                },
              ],
            };
          }
          const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd);
          const headSha = await getRepoSha(target);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "created_from_remote",
                  task: identity,
                  worktree: target,
                  kind: params.slot ? "lane" : "canonical",
                  slot: params.slot ?? null,
                  branch: params.branch,
                  branchSource: "remote",
                  upstream: `${remote}/${params.branch}`,
                  remoteSha,
                  base: null,
                  inputRepo,
                  headSha,
                }),
              },
            ],
            details: { status: "created_from_remote", worktree: target },
          };
        }

        // 6c. Both absent — base selection
        let baseSha: string;
        let baseRef: string;

        if (params.base_ref) {
          const baseRes = await git(sourceRoot, "rev-parse", params.base_ref);
          if (!baseRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Invalid base ref: ${params.base_ref}`,
                  }),
                },
              ],
            };
          }
          baseSha = baseRes.stdout;
          baseRef = params.base_ref;
        } else {
          // Refs were already refreshed by the required fetch in 6b; base
          // selection must not trigger a second fetch for the same decision.
          // Determine remote default branch
          const symRef = await git(
            sourceRoot,
            "symbolic-ref",
            `refs/remotes/${remote}/HEAD`,
          );
          let remoteDefault = "";
          if (symRef.ok) {
            remoteDefault = symRef.stdout.replace(
              `refs/remotes/${remote}/`,
              "",
            );
          } else {
            // Fallback: git remote show
            const show = await git(sourceRoot, "remote", "show", remote);
            const m = show.stdout.match(/HEAD branch:\s*(\S+)/);
            if (m) remoteDefault = m[1];
          }

          if (!remoteDefault) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Cannot determine remote default branch for ${remote}`,
                  }),
                },
              ],
            };
          }

          const devRef = await git(
            sourceRoot,
            "show-ref",
            "--verify",
            `refs/remotes/${remote}/develop`,
          );
          if (remoteDefault !== "develop" && devRef.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "base_selection_required",
                    remoteDefault,
                    developExists: true,
                  }),
                },
              ],
            };
          }

          const baseBranch = `${remote}/${remoteDefault}`;
          const baseRes = await git(sourceRoot, "rev-parse", baseBranch);
          if (!baseRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Cannot resolve base branch ${baseBranch}`,
                  }),
                },
              ],
            };
          }
          baseSha = baseRes.stdout;
          baseRef = baseBranch;
        }
        // Create branch from base
        await mkdir(ws, { recursive: true });
        const add = await git(
          sourceRoot,
          "worktree",
          "add",
          "-b",
          params.branch,
          target,
          baseSha,
        );
        if (!add.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Failed to create worktree with branch: ${add.stderr}`,
                }),
              },
            ],
          };
        }
        const inputRepo = await getInputRepoFacts(sourceAbs, sourceRoot, cwd);
        const headSha = await getRepoSha(target);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "created",
                task: identity,
                worktree: target,
                kind: params.slot ? "lane" : "canonical",
                slot: params.slot ?? null,
                branch: params.branch,
                branchSource: "base",
                upstream: null,
                base: { ref: baseRef, sha: baseSha },
                inputRepo,
                headSha,
              }),
            },
          ],
          details: { status: "created", worktree: target },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: (e as Error).message,
              }),
            },
          ],
        };
      }
    },
  });

  // ─── remove_task_lane ─────────────────────────────────────────────────
  pi.registerTool({
    name: "remove_task_lane",
    label: "Remove Task Lane",
    description:
      "Safely remove one clean secondary lane from its managed task workspace. Canonical worktrees are rejected; worktree removal and branch deletion are both non-force operations.",
    parameters: tb.Object({
      task: tb.String({
        description: "Canonical task identity (workspace name)",
      }),
      path: tb.String({
        description: "Absolute or session-relative path to the secondary lane",
      }),
    }),
    approval: "write",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const cwd = realpath(_ctx.cwd);
        const target = realpath(expandPath(params.path, cwd));
        const workspace = realpath(taskWorkspacePath(params.task));
        const relativeTarget = relative(workspace, target);
        const laneName = basename(target);
        const parsedLane = parseLaneName(laneName);
        const isDirectChild =
          relativeTarget.length > 0 &&
          !relativeTarget.startsWith("..") &&
          !relativeTarget.includes("/") &&
          resolve(workspace, relativeTarget) === target;

        if (!isDirectChild || !parsedLane) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "lane_rejected",
                  task: params.task,
                  path: target,
                  reason:
                    "Only a secondary lane directly inside the requested managed task workspace can be removed.",
                }),
              },
            ],
          };
        }

        const repo = parsedLane.repo;
        const slot = parsedLane.slot;
        const root = findGitRoot(target);
        const classification = classifyPath(target, cwd);
        const canonicalPath = join(workspace, repo);
        const linked = new Map<string, LinkedWorktreeFact>();
        if (
          classification === "MANAGED_TASK_WORKTREE" &&
          root === target &&
          isLinkedWorktree(target)
        ) {
          linked.set(laneName, {
            path: target,
            commonDir: await getRepoCommonDir(target),
          });
        }
        if (
          existsSync(canonicalPath) &&
          findGitRoot(canonicalPath) === canonicalPath &&
          isLinkedWorktree(canonicalPath)
        ) {
          linked.set(repo, {
            path: canonicalPath,
            commonDir: await getRepoCommonDir(canonicalPath),
          });
        }
        const identity = laneIdentity(laneName, linked);
        if (
          classification !== "MANAGED_TASK_WORKTREE" ||
          root !== target ||
          identity.kind !== "lane"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "lane_rejected",
                  task: params.task,
                  repo,
                  slot,
                  path: target,
                  classification,
                  reason:
                    "The target is not a managed linked secondary lane with a canonical sibling.",
                }),
              },
            ],
          };
        }

        const facts = await getLaneFacts(params.task, target, slot, repo);
        if (!facts.branch) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "lane_rejected",
                  ...facts,
                  reason: "A secondary lane must have an attached local branch.",
                }),
              },
            ],
          };
        }
        if (facts.dirty.staged.length > 0 || facts.dirty.unstaged.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "lane_dirty",
                  ...facts,
                  reason:
                    "Refusing to remove a dirty lane; inspect or commit its changes first.",
                }),
              },
            ],
          };
        }

        const worktrees = await git(target, "worktree", "list", "--porcelain");
        const controlPath = worktrees.ok
          ? parseWorktreePaths(worktrees.stdout).find(
              (path) => realpath(path) !== target,
            )
          : undefined;
        if (!controlPath) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "lane_rejected",
                  ...facts,
                  reason:
                    "Cannot find another worktree from which to perform safe lane cleanup.",
                }),
              },
            ],
          };
        }

        const remove = await git(controlPath, "worktree", "remove", target);
        if (!remove.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "worktree_remove_failed",
                  ...facts,
                  reason: remove.stderr,
                }),
              },
            ],
          };
        }

        const deleteBranch = await git(controlPath, "branch", "-d", facts.branch);
        if (!deleteBranch.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "branch_delete_blocked",
                  ...facts,
                  reason:
                    `Worktree removed, but safe branch deletion was refused: ${deleteBranch.stderr}. The branch was not force-deleted.`,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "removed",
                ...facts,
              }),
            },
          ],
          details: { status: "removed", ...facts },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: (e as Error).message,
              }),
            },
          ],
        };
      }
    },
  });

  // ─── checkpoint_commit ───────────────────────────────────────────────
  pi.registerTool({
    name: "checkpoint_commit",
    label: "Checkpoint Commit",
    description:
      "Stage exact paths and commit within a repository. Guards: blocks primary checkout unless allow_primary=true, rejects secret-like paths, verifies paths inside repo, enforces exact staging, requires hooks to run. deferred_hook enables controlled commit with deferred hook verification after a real external-prerequisite hook failure.",
    parameters: tb.Object({
      repo: tb.String({ description: "Repository path (root or dir inside one)" }),
      paths: tb.Array(tb.String(), {
        description: "Exact file paths to stage and commit",
      }),
      message: tb.String({ description: "Commit message" }),
      allow_primary: tb.Optional(
        tb.Boolean({
          description:
            "Allow committing to primary checkout (manual source commit exception)",
        }),
      ),
      deferred_hook: tb.Optional(
        tb.Object(
          {
            blocker_kind: tb.Union([
              tb.Literal("external_prerequisite"),
              tb.Literal("external_availability"),
            ]),
            failed_hook: tb.String(),
            failed_step_command: tb.String(),
            failure_reason: tb.String(),
            staged_tree: tb.String({
              description:
                "Staged tree SHA from the commit_failed response this evidence refers to (proves the verified contents are the contents being committed)",
            }),
            manual_checks: tb.Array(
              tb.Object({
                command: tb.String(),
                result: tb.String({
                  description:
                    "Machine-readable outcome: pass | passed | ok | success | successful | true | yes (case-insensitive). Anything else — failure, skipped, unknown, prose — does not authorize the bypass.",
                }),
              }),
            ),
            remaining_gap: tb.String(),
          },
          {
            description:
              "Deferred hook verification evidence. Only for hook failures caused by an external prerequisite or availability blocker (e.g. unpublished same-task dependency) — never for test/lint/typecheck/format/secret-scan failures. The normal hooked commit is always attempted first, in the same call. Evidence is bound to the exact staged tree reported by the failed attempt.",
          },
        ),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        // 1. Classify repo (canonicalize cwd to avoid symlink mismatches)
        const cwd = realpath(_ctx.cwd);
        const repoAbs = expandPath(params.repo, cwd);
        const classification = classifyPath(repoAbs, cwd);
        const repoRoot = realpath(findGitRoot(repoAbs) ?? repoAbs);

        if (classification === "PRIMARY_CHECKOUT" && !params.allow_primary) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "primary_commit_blocked",
                  reason: `Refusing to commit to primary checkout ${repoRoot}. Use allow_primary=true or commit to a task worktree instead.`,
                }),
              },
            ],
          };
        }

        // 2. Verify all paths resolve inside repoRoot
        const offenders: string[] = [];
        const resolvedPaths: string[] = [];
        for (const p of params.paths) {
          // Paths are repo-scoped: relative entries resolve against the repo
          // root, not the session cwd — `repo` may live in another directory.
          const abs = p.startsWith("/") ? p : p.startsWith("~") ? expandPath(p, cwd) : resolve(repoRoot, p);
          const resolved = resolve(abs);
          if (!resolved.startsWith(repoRoot + "/") && resolved !== repoRoot) {
            offenders.push(p);
          } else {
            resolvedPaths.push(resolved);
          }
        }
        if (offenders.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "path_outside_repo",
                  offenders,
                }),
              },
            ],
          };
        }

        // 3. Secret check
        const secrets: string[] = [];
        for (const p of resolvedPaths) {
          if (isSecretPath(p)) secrets.push(p);
        }
        if (secrets.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "secret_path_rejected",
                  offenders: secrets,
                }),
              },
            ],
          };
        }

        // 4. Pre-staged check
        const cached = await git(repoRoot, "diff", "--cached", "--name-only");
        if (cached.ok && cached.stdout) {
          const existingStaged = new Set(
            cached.stdout.split("\n").filter((f) => f),
          );
          const intendedSet = new Set(
            resolvedPaths.map((p) => relative(repoRoot, p)),
          );
          const different =
            existingStaged.size !== intendedSet.size ||
            [...existingStaged].some((f) => !intendedSet.has(f));
          if (different) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "ambiguous_staged",
                    staged: [...existingStaged],
                    intended: [...intendedSet],
                  }),
                },
              ],
            };
          }
        }

        // 5. Stage exactly the intended paths
        const relPaths = resolvedPaths.map((p) => relative(repoRoot, p));
        const stage = await git(repoRoot, "add", "--", ...relPaths);
        if (!stage.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  message: `Failed to stage files: ${stage.stderr}`,
                }),
              },
            ],
          };
        }

        // 6. Commit (hooks run normally)
        let commit = await git(repoRoot, "commit", "-m", params.message);

        // 7. Hook-modified retry: some hooks rewrite the files they inspect
        // (formatters, import sorting). Re-stage only the intended paths and
        // retry the normal hooked commit once before any failure handling.
        if (!commit.ok) {
          const diffCheck = await git(repoRoot, "diff", "--name-only");
          if (diffCheck.ok && diffCheck.stdout) {
            const modifiedFiles = new Set(diffCheck.stdout.split("\n"));
            const needsRestage = relPaths.some((p) => modifiedFiles.has(p));
            if (needsRestage) {
              await git(repoRoot, "add", "--", ...relPaths);
              commit = await git(repoRoot, "commit", "-m", params.message);
            }
          }
        }
        if (!commit.ok) {
          const failureOutput = `${commit.stderr}\n${commit.stdout}`;
          if (!params.deferred_hook) {
            const finalTreeSha = (await git(repoRoot, "write-tree")).stdout.trim();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "commit_failed",
                    stderr: commit.stderr,
                    staged_tree: finalTreeSha,
                    deferred_hook_hint:
                      "If and only if this hook failure is caused by an external prerequisite that cannot be satisfied at this task stage (e.g. an unpublished same-task dependency) — not by a code-validation failure — retry checkpoint_commit with deferred_hook evidence naming the failing step and passing this staged_tree value verbatim.",
                  }),
                },
              ],
            };
          }
          const d = params.deferred_hook;
          // Evidence is bound to the exact final staged tree of the failed
          // attempt (after any hook-induced restage). A tree mismatch means
          // the verified contents are not the contents being committed.
          const finalTreeSha = (await git(repoRoot, "write-tree")).stdout.trim();
          const evidenceTreeMatches =
            finalTreeSha !== "" && d.staged_tree.trim() === finalTreeSha;
          const evidenceMatches =
            d.failed_step_command.trim().length > 0 &&
            failureOutput.includes(d.failed_step_command);
          const checksComplete =
            d.failed_hook.trim().length > 0 &&
            d.failure_reason.trim().length > 0 &&
            d.remaining_gap.trim().length > 0 &&
            d.manual_checks.length > 0 &&
            d.manual_checks.every(
              (c) =>
                c.command.trim().length > 0 &&
                DEFERRED_PASS_RESULTS[c.result.trim().toLowerCase()] === true,
            );
          if (!evidenceTreeMatches || !evidenceMatches || !checksComplete) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "deferred_hook_rejected",
                    evidenceTreeMatches,
                    evidenceMatches,
                    checksComplete,
                    reason:
                      "Deferred hook verification requires a current hook failure, evidence bound to the exact staged tree being committed, and manual checks with machine-readable pass results. Fix the failure or escalate instead of bypassing.",
                  }),
                },
              ],
            };
          }
          const bypass = await git(repoRoot, "commit", "--no-verify", "-m", params.message);
          if (!bypass.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "error",
                    message: `Deferred hook commit failed: ${bypass.stderr}`,
                  }),
                },
              ],
            };
          }
          const deferredLog = await git(repoRoot, "log", "-1", "--format=%H");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "committed_with_deferred_hook",
                  commit: deferredLog.stdout,
                  branch: await getRepoBranch(repoRoot),
                  files: relPaths,
                  failed_hook: d.failed_hook,
                  failure_reason: d.failure_reason,
                  manual_checks: d.manual_checks,
                  remaining_gap: d.remaining_gap,
                  note:
                    "Do not report this repository fully verified. Re-run the deferred check once the prerequisite is available (a pass closes the gap); surface the gap in any MR or task report.",
                }),
              },
            ],
            details: {
              status: "committed_with_deferred_hook",
              commit: deferredLog.stdout,
              remaining_gap: d.remaining_gap,
            },
          };
        }

        if (!commit.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "commit_failed",
                  stderr: commit.stderr,
                }),
              },
            ],
          };
        }

        // 8. Verify
        const log = await git(repoRoot, "log", "-1", "--format=%H");
        const status = await git(repoRoot, "status", "--porcelain");
        const branch = await getRepoBranch(repoRoot);
        const remainingDirty = status.ok
          ? status.stdout
            ? status.stdout.split("\n")
            : []
          : [];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "committed",
                commit: log.stdout,
                branch,
                files: relPaths,
                remainingDirty,
              }),
            },
          ],
          details: {
            status: "committed",
            commit: log.stdout,
            branch,
            files: relPaths,
          },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                message: (e as Error).message,
              }),
            },
          ],
        };
      }
    },
  });

  // ─── Mutation guard (tool_call interceptor) ──────────────────────────
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as Record<string, unknown>;
      const filePath = input.path as string | undefined;
      if (!filePath) return;
      // Internal URLs are dispatched by the core router, never resolved as
      // filesystem paths — skip classification entirely (field-run F1).
      if (INTERNAL_URI_RE.test(filePath.trim())) return;

      // Session-bound cwd (NOT process.cwd()): workspace-rooted child sessions
      // share the parent process, so relative targets must resolve against the
      // session's own directory to classify the real write target.
      const cwd = realpath(ctx.cwd);
      const abs = realpath(expandPath(filePath, cwd));
      if (isTemporaryPath(abs)) return;
      const root = findGitRoot(abs);
      if (root && isGitMetadataPath(root, abs)) {
        return {
          block: true,
          reason: `Blocked: writing to Git metadata under ${join(root, ".git")} is not allowed.`,
        };
      }
      const classification = classifyPath(filePath, cwd);

      if (classification === "PRIMARY_CHECKOUT") {
        // Ignored, untracked, non-symlink paths stay writable in the primary
        // checkout; everything else routes to the managed task worktree(s).
        if (root && !isAllowedIgnoredPrimaryPath(root, abs)) {
          const hint = managedWorktreeHint(root);
          if (hint) {
            return {
              block: true,
              reason: `Blocked: writing to primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; write to the managed worktree or report the blocker.`,
            };
          }
        }
      }
      return;
    }

    if (event.toolName !== "bash") return;
    const input = event.input as Record<string, unknown>;
    const command = input.command as string | undefined;
    if (!command) return;

    const invocations = parseGitInvocations(command);

    // Raw hook bypass is policy, not routing: forbidden everywhere, including
    // managed worktrees. The controlled deferral path lives in
    // checkpoint_commit, which requires a real, current hook failure first.
    if (invocations.some((inv) => inv.mutating && inv.noVerify)) {
      return {
        block: true,
        reason:
          "Blocked: raw `git commit --no-verify` bypasses pre-commit hooks. Commit normally (hooks run); if a hook fails on an external prerequisite such as an unpublished same-task dependency, retry via checkpoint_commit with deferred_hook evidence.",
      };
    }
    const cwd = realpath(ctx.cwd);
    if (
      hasTemporaryShellCwd(command) &&
      invocations.every((inv) => !inv.mutating || inv.repoRef === null)
    ) return;

    // Compound commands must not hide a mutating git invocation behind
    // read-only ones: EVERY git invocation in the command is classified, and
    // any mutating one aimed at a primary checkout with managed worktrees
    // blocks the whole command (fail closed on ambiguity).
    for (const inv of invocations) {
      if (!inv.mutating) continue;
      const repoRef = inv.repoRef ?? ".";
      // A URI-like repo ref (git -C local://… …) is never a filesystem repo.
      if (INTERNAL_URI_RE.test(repoRef.trim())) continue;
      const repoAbs = expandPath(repoRef, cwd);
      if (isTemporaryPath(repoAbs)) continue;
      let classification: PathClassification;
      try {
        classification = classifyPath(repoAbs, cwd);
      } catch {
        continue; // unresolvable -C target can never be the primary checkout
      }
      if (classification !== "PRIMARY_CHECKOUT") continue;
      const root = findGitRoot(repoAbs);
      if (!root) continue;
      const hint = managedWorktreeHint(root);
      if (!hint) continue;
      return {
        block: true,
        reason: `Blocked: mutating git command on primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; run the command in the managed worktree or report the blocker.`,
      };
    }
  });
}
