/**
 * task-workspace — the git routing policy consulted by the PATH shim.
 *
 * Input is the REAL working directory plus the REAL argv of one git
 * invocation (no shell string anywhere; there is no Bash parsing left in
 * agent-kit). Verdict rules, in order:
 *
 *   1. `--no-verify` on a mutating command is blocked EVERYWHERE — policy,
 *      not routing; the controlled recovery path is checkpoint_commit with
 *      deferred_hook evidence.
 *   2. Read-only, safe-refresh, and external side effects (`push`) pass.
 *   3. Local/ref mutations fail closed on repository redirection
 *      (`--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`).
 *   4. Remaining mutations are routed by the REAL git repo dir: the `-C`
 *      chain is resolved left-to-right, each relative path against the
 *      previous result. Under a temporary root, outside git, under the
 *      task root (managed worktree), or a linked worktree outside the
 *      task root → pass. The primary checkout of a repository that HAS
 *      managed worktrees → blocked with the routing message.
 *   5. Never throws: internal errors fail closed.
 *
 * The policy is host-neutral glue: plain ESM, node/bun stdlib only, and it
 * reads exactly one piece of configuration — AGENT_TASK_ROOT from its
 * environment, placed there by the extension's bash spawnHook.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  classifyInvocationTokens,
  splitGitGlobalArgs,
} from "./classify.mjs";

/** macOS /tmp is a symlink to /private/tmp; both roots are scratch space. */
const TEMPORARY_ROOT_RE = /^\/(?:private\/)?tmp(?:\/|$)/;

/** URI-like -C targets are session resources, never filesystem repos
 *  (rule migrated from the former guard): real git cannot chdir into them,
 *  so no filesystem location can be affected. */
const INTERNAL_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const NO_VERIFY_REASON =
  "Blocked: raw `git commit --no-verify` bypasses pre-commit hooks. Commit normally (hooks run); if a hook fails on an external prerequisite such as an unpublished same-task dependency, retry via checkpoint_commit with deferred_hook evidence.";

const REDIRECT_REASON =
  "Blocked: git ran with an explicit git dir or work tree (--git-dir, --work-tree, GIT_DIR, or GIT_WORK_TREE), so the mutation cannot be routed to the managed worktrees. Run the mutation as git -C <managed worktree> instead (read-only git passes). This block is a routing failure, not a bypass authorization — do not work around it; run the command in the managed worktree or report the blocker.";

const UNCONFIGURED_REASON =
  "Blocked: the task-workspace guard has no task root configured, so git routing cannot be analyzed safely. Use the managed task worktree(s) for this repository. This block is a routing failure, not a bypass authorization; run the command in the managed worktree or report the blocker.";

const INTERNAL_ERROR_REASON =
  "Blocked: the task-workspace guard could not analyze this git invocation (internal error) and fails closed. Run the command in the managed task worktree or report the blocker.";

function allow() {
  return { verdict: "ALLOW" };
}

function block(reason) {
  return { verdict: "BLOCK", reason };
}

/** Non-throwing realpath: a path whose tail does not exist yet is rejoin-
 *  ed from its first existing parent (same contract as the core's realpath
 *  in git.ts). */
function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    const parts = p.split("/");
    let existing = "";
    for (const part of parts) {
      if (!part) {
        existing = "/";
        continue;
      }
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

function isTemporaryPath(p) {
  return TEMPORARY_ROOT_RE.test(p);
}

function findGitRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isLinkedWorktree(repoRoot) {
  try {
    return readFileSync(join(repoRoot, ".git"), "utf8").startsWith("gitdir:");
  } catch {
    return false;
  }
}

function underTaskRoot(p, taskRoot) {
  return taskRoot !== "" && (p.startsWith(taskRoot + "/") || p === taskRoot);
}

/** Managed worktrees of the SAME repository (scanning approach reused from
 *  the core's managedWorktreeHint): all of them when several exist, none
 *  invented when there are none. */
function managedWorktreeHint(root, taskRoot) {
  let proc;
  try {
    proc = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  if (!proc || proc.status !== 0) return null;
  const managed = [];
  for (const line of String(proc.stdout ?? "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (underTaskRoot(wt, taskRoot)) managed.push(wt);
  }
  if (managed.length === 0) return null;
  if (managed.length === 1) return managed[0];
  const shown = managed.slice(0, 8).join("\n  ");
  return `\n  ${shown}${managed.length > 8 ? `\n  … (${managed.length} managed worktrees total)` : ""}`;
}

/** Real git `-C` semantics: start at the real cwd; every `-C <path>` is
 *  resolved left-to-right, each relative path against the PREVIOUS result
 *  (`git -C /repo -C sub commit` → `/repo/sub`). Literal path resolution —
 *  the shell already expanded tildes, and git itself never expands them. */
function resolveChain(cwd, chain) {
  let dir = cwd;
  for (const step of chain) {
    dir = isAbsolute(step) ? step : join(dir, step);
  }
  return realpathSafe(dir);
}

/**
 * The verdict for one git invocation. `cwd` is the real (physical) working
 * directory, `argv` the real arguments after the `git` command word, `env`
 * the shim's environment, `taskRoot` the resolved task workspace root
 * ("" = unconfigured → mutations fail closed).
 */
export function decidePolicy({ cwd, argv, env, taskRoot }) {
  try {
    const { chain, hasGitDir, hasWorkTree, rest } = splitGitGlobalArgs(argv);
    const cls = classifyInvocationTokens(rest[0] ?? "", rest.slice(1));
    const mutating =
      cls.operationClass === "local/ref-mutation" ||
      cls.operationClass === "ambiguous";

    // Raw hook bypass is policy, not routing: forbidden everywhere,
    // including managed worktrees. Checked BEFORE any routing.
    if (mutating && cls.noVerify) return block(NO_VERIFY_REASON);

    if (!mutating) return allow(); // read-only, safe-refresh
    if (cls.operationClass === "external-side-effect") return allow(); // push

    // Redirection fail-closed: an explicit git dir/work tree bypasses the
    // managed-worktree routing. Read-only commands already passed above.
    if (hasGitDir || hasWorkTree || env.GIT_DIR || env.GIT_WORK_TREE) {
      return block(REDIRECT_REASON);
    }

    if (taskRoot === "") return block(UNCONFIGURED_REASON);

    if (chain.some((step) => INTERNAL_URI_RE.test(step.trim()))) return allow();
    const dir = resolveChain(cwd, chain);
    if (isTemporaryPath(dir)) return allow();
    const root = findGitRoot(dir);
    if (!root) return allow(); // not inside a repository
    if (underTaskRoot(realpathSafe(root), taskRoot)) return allow(); // managed
    if (isLinkedWorktree(root)) return allow(); // another linked worktree
    const hint = managedWorktreeHint(root, taskRoot);
    if (!hint) return allow(); // primary checkout without managed worktrees
    return block(
      `Blocked: mutating git command on primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; run the command in the managed worktree or report the blocker.`,
    );
  } catch {
    return block(INTERNAL_ERROR_REASON);
  }
}

/** CLI entry: argv = <cwd> <gitArgv…>; prints exactly one line
 *  "ALLOW" or "BLOCK <reason>"; always exits 0 — a missing/unparsable
 *  verdict makes the shim fail closed, so the policy never needs a
 *  nonzero exit to express a block. */
export function main(argv) {
  const [cwd = "/", ...gitArgv] = argv;
  const env = process.env;
  const rawRoot = env.AGENT_TASK_ROOT?.trim() ?? "";
  const taskRoot = rawRoot === "" ? "" : realpathSafe(rawRoot);
  const verdict = decidePolicy({ cwd, argv: gitArgv, env, taskRoot });
  if (verdict.verdict === "BLOCK") {
    process.stdout.write(`BLOCK ${verdict.reason}\n`);
  } else {
    process.stdout.write("ALLOW\n");
  }
}

const thisFile = (() => {
  try {
    return realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return "";
  }
})();
const entryFile = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]);
      } catch {
        return process.argv[1];
      }
    })()
  : "";
if (import.meta.main || (entryFile !== "" && entryFile === thisFile)) {
  main(process.argv.slice(2));
}
