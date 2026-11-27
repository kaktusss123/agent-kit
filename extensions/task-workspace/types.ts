/**
 * task-workspace core — host-neutral shared types.
 *
 * Everything in ./task-workspace/ is the host-independent deterministic core
 * of the task-workspace runtime: no pi SDK imports, no extension plumbing.
 */

import type { OwnerView } from "./owner-lock.ts";

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

/** Branch, HEAD, upstream and dirty state of one worktree. `branch` is ""
 *  on detached HEAD, `headSha` is "" on an unborn branch, and an unreadable
 *  worktree degrades to empty values rather than failing the scan. */
export type WorktreeGitFacts = {
  branch: string;
  headSha: string;
  upstream: string | null;
  dirty: DirtyState;
};

type ManagedRepoIdentity = {
  name: string;
  path: string;
  kind: "canonical" | "lane";
  slot: string | null;
  classification: "MANAGED_TASK_WORKTREE";
  /** Cross-process ownership of this worktree (diagnostics). */
  owner?: OwnerView;
};

/** One managed worktree in task_status. `facts: "omitted"` marks a worktree
 *  of another repository than the requested one: its Git facts were not
 *  collected, so the fields are absent rather than fabricated. */
export type ManagedRepoStatus =
  | (ManagedRepoIdentity & { facts: "full" } & WorktreeGitFacts)
  | (ManagedRepoIdentity & { facts: "omitted" });

/** Which worktrees task_status collected Git facts for: every one, or only
 *  those sharing the requested repository's (realpath) common Git dir. */
export type FactsScope = "all" | { commonDir: string };

export type GitOperationClass =
  | "read-only"
  | "safe-refresh"
  | "local/ref-mutation"
  | "external-side-effect"
  | "ambiguous";

/** Classification of one git invocation's real argv (after the `git`
 *  command word and global-flag consumption). Produced by the shared
 *  classifier in shim/classify.mjs; the repo dir itself is resolved by the
 *  runtime policy from cwd + the -C chain, not represented here. */
export interface GitInvocationClassification {
  subcommand: string;
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

// ─── bootstrap (worktree dependency provisioning) ───────────────────────

export interface BootstrapLink {
  name: string;
  source: string;
  target: string;
  action: "created" | "kept" | "repointed" | "conflict" | "source_missing";
}

export interface BootstrapResult {
  status: "provisioned" | "current" | "not_applicable" | "skipped";
  links: BootstrapLink[];
  reason?: string;
}

