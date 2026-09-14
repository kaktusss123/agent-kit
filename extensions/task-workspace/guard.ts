/**
 * task-workspace core — write/edit guard verdicts and shared git
 * classification re-exports.
 *
 * Git policy is enforced where git actually executes: the pi binding
 * (index.ts) overrides the bash tool and prepends a PATH shim
 * (./shim/git) to every bash child, so every real `git` invocation
 * reports its post-`cd` working directory and exact argv to the policy
 * module (./shim/policy.mjs), which classifies with the shared tables in
 * ./shim/classify.mjs and routes local mutations to managed task
 * worktrees. There is deliberately NO Bash parsing anywhere in agent-kit;
 * this module keeps only the write/edit guard plus thin typed re-exports
 * of the shared classification (single source of truth: classify.mjs).
 */
import { basename, join } from "node:path";
import {
  classifyPath,
  expandPath,
  findGitRoot,
  isAllowedIgnoredPrimaryPath,
  isGitMetadataPath,
  managedWorktreeHint,
  realpath,
} from "./git";
import type { GuardVerdict, PathClassification } from "./types";

// Shared classification tables and rules live in ./shim/classify.mjs —
// the same module the runtime policy uses. Re-exported here (with the thin
// typed wrapper below) so TypeScript consumers never duplicate them.
export {
  BRANCH_MUTATION_FLAGS,
  BRANCH_READ_ONLY_FLAGS,
  FETCH_VALUE_FLAGS,
  GIT_VALUE_FLAGS,
  LOCAL_MUTATION_GIT_SUBCOMMANDS,
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_ONLY_VALUE_FLAGS,
  TAG_MUTATION_FLAGS,
  TAG_READ_ONLY_FLAGS,
  classifyBranchOperation,
  classifyFetchOperation,
  classifyFetchRefspec,
  classifyInvocationTokens,
  classifyRemoteOperation,
  classifyTagOperation,
  splitGitGlobalArgs,
} from "./shim/classify.mjs";
import { classifyInvocationTokens, splitGitGlobalArgs } from "./shim/classify.mjs";

/** Thin typed wrapper over the shared classifier: one git invocation's
 *  real argv (after the `git` command word) → its verdict. */
export function classifyGitInvocation(
  argv: string[],
): GitInvocationClassification {
  const { rest } = splitGitGlobalArgs(argv);
  return classifyInvocationTokens(rest[0] ?? "", rest.slice(1));
}

/** Internal-URL targets are session resources, never filesystem paths. */
const INTERNAL_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const SECRET_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

export function isSecretPath(filePath: string): boolean {
  const base = basename(filePath);
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  if (/\.(pem|key)$/.test(base)) return true;
  if (/credentials/.test(base)) return true;
  if (/^secrets\./.test(base)) return true;
  return false;
}

// ─── Guard verdicts (host-neutral) ──────────────────────────────────────

/** Verdict for a write/edit tool call aimed at filePath (session cwd ctxCwd). */
export function guardManagedWriteTarget(
  filePath: string | undefined,
  ctxCwd: string,
  opts: { taskRoot: string },
): GuardVerdict {
  if (!filePath) return undefined;
  // Internal URLs are dispatched by the core router, never resolved as
  // filesystem paths — skip classification entirely (field-run F1).
  if (INTERNAL_URI_RE.test(filePath.trim())) return undefined;

  // Session-bound cwd (NOT process.cwd()): workspace-rooted child sessions
  // share the parent process, so relative targets must resolve against the
  // session's own directory to classify the real write target.
  const cwd = realpath(ctxCwd);
  const abs = realpath(expandPath(filePath, cwd));
  if (isTemporaryPath(abs)) return undefined;
  const root = findGitRoot(abs);
  if (root && isGitMetadataPath(root, abs)) {
    return {
      block: true,
      reason: `Blocked: writing to Git metadata under ${join(root, ".git")} is not allowed.`,
    };
  }
  const classification = classifyPath(filePath, cwd, opts.taskRoot);

  if (classification === "PRIMARY_CHECKOUT") {
    // Ignored, untracked, non-symlink paths stay writable in the primary
    // checkout; everything else routes to the managed task worktree(s).
    if (root && !isAllowedIgnoredPrimaryPath(root, abs)) {
      const hint = managedWorktreeHint(root, opts.taskRoot);
      if (hint) {
        return {
          block: true,
          reason: `Blocked: writing to primary checkout ${root}. Use the managed task worktree(s) of this repo: ${hint}. This block is a routing failure, not a bypass authorization — do not work around it with eval, Python, shell, or another agent; write to the managed worktree or report the blocker.`,
        };
      }
    }
  }
  return undefined;
}
