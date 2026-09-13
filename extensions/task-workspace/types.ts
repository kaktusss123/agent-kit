/**
 * task-workspace core — host-neutral shared types.
 *
 * Everything in ./task-workspace/ is the host-independent deterministic core
 * of the task-workspace runtime: no pi SDK imports, no extension plumbing.
 */

// Path classification for a filesystem location relative to the task root.
export type PathClassification =
  | "OUTSIDE_GIT"
  | "PRIMARY_CHECKOUT"
  | "MANAGED_TASK_WORKTREE"
  | "OTHER_LINKED_WORKTREE";

export type DirtyState = { staged: string[]; unstaged: string[] };

export interface InputRepoFacts {
  inputPath: string;
  gitRoot: string;
  classification: PathClassification;
  branch: string;
  headSha: string;
  dirty: DirtyState;
}

export type LinkedWorktreeFact = {
  path: string;
  commonDir: string | null;
};

export type ManagedRepoStatus = {
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

export type GitOperationClass =
  | "read-only"
  | "safe-refresh"
  | "local/ref-mutation"
  | "external-side-effect"
  | "ambiguous";

export interface ParsedGitInvocation {
  subcommand: string;
  repoRef: string | null; // -C <path> target, or null for the session cwd
  operationClass: GitOperationClass;
  mutating: boolean;
  noVerify: boolean;
}

/** What a host guard hook should return when it blocks a tool call. */
export interface GuardBlock {
  block: true;
  reason: string;
}
export type GuardVerdict = GuardBlock | undefined;

