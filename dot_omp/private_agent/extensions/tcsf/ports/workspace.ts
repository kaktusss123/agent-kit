/**
 * WorkspacePort - Git workspace management and change capture
 * 
 * This port owns Git facts and task worktrees. The default adapter uses Git CLI
 * with explicit arguments and canonical paths.
 */

/** Repository inspection result */
export interface RepoInspection {
  /** Canonical absolute path to repo root */
  readonly canonicalRoot: string;
  /** Current HEAD commit SHA */
  readonly headSha: string;
  /** Protected fingerprint (hash of state) */
  readonly fingerprint: string;
  /** Working tree cleanliness status */
  readonly isClean: boolean;
  /** List of tracked files */
  readonly trackedFiles: string[];
  /** List of untracked files (relative to root) */
  readonly untrackedFiles: string[];
  /** List of staged changes */
  readonly stagedChanges: string[];
  /** Repository role */
  readonly role: RepositoryRole;
}

/** Repository role in task execution */
export type RepositoryRole = "primary" | "target" | "reference";

/** Input for preparing task workspaces */
export interface PrepareWorkspacesInput {
  /** Task ID for workspace naming */
  readonly taskId: string;
  /** Task storage root (TCSF_HOME or ~/.omp/tcsf) */
  readonly taskRoot: string;
  /** Repositories from approved contract */
  readonly repositories: RepositoryContract[];
  /** Base directory for worktrees (under taskRoot) */
  readonly worktreesDir: string;
}

/** Repository contract from approved packet */
export interface RepositoryContract {
  /** Canonical source path */
  readonly canonicalPath: string;
  /** Base SHA for the task */
  readonly baseSha: string;
  /** Repository role */
  readonly role: RepositoryRole;
  /** Repository key for collision detection */
  readonly repoKey: string;
  /** Approved writable scope (glob patterns) */
  readonly writableScope?: string[];
}

/** Set of prepared workspaces */
export interface WorkspaceSet {
  /** Map of repo key to workspace */
  readonly workspaces: Map<string, Workspace>;
  /** Task ID */
  readonly taskId: string;
  /** Preparation timestamp */
  readonly preparedAt: string;
}

/** Individual workspace */
export interface Workspace {
  /** Repository role */
  readonly role: RepositoryRole;
  /** Canonical path to workspace (worktree or source) */
  readonly canonicalPath: string;
  /** Base SHA */
  readonly baseSha: string;
  /** Repo key */
  readonly repoKey: string;
  /** Whether this is a worktree (false for reference repos) */
  readonly isWorktree: boolean;
  /** Worktree path (if created) */
  readonly worktreePath?: string;
  /** Approved writable scope */
  readonly writableScope?: string[];
  /** Protected fingerprint at preparation */
  readonly fingerprint: string;
}

/** Set of captured changes */
export interface ChangeSet {
  /** Map of repo key to changes */
  readonly changes: Map<string, RepoChanges>;
  /** Capture timestamp */
  readonly capturedAt: string;
}

/** Changes in a single repository */
export interface RepoChanges {
  /** Repo key */
  readonly repoKey: string;
  /** List of modified files (relative paths) */
  readonly modifiedFiles: string[];
  /** List of added files (relative paths) */
  readonly addedFiles: string[];
  /** List of deleted files (relative paths) */
  readonly deletedFiles: string[];
  /** Files changed in commits after the approved base */
  readonly committedFiles?: string[];
  /** List of unauthorized changes (outside writable scope) */
  readonly unauthorizedFiles: string[];
  /** Git diff stat */
  readonly diffStat: string;
  /** Whether changes are authorized */
  readonly isAuthorized: boolean;
}

/** Input for restoring unauthorized changes */
export interface RestoreUnauthorizedInput {
  /** Workspace set */
  readonly workspaceSet: WorkspaceSet;
  /** Changes to restore */
  readonly changeSet: ChangeSet;
  /** Repositories with unauthorized changes */
  readonly unauthorizedRepos: string[];
}

/** Result of restoration */
export interface RestoreResult {
  /** Map of repo key to restoration result */
  readonly results: Map<string, RepoRestoreResult>;
  /** Whether all restorations succeeded */
  readonly allSucceeded: boolean;
  /** Restoration timestamp */
  readonly restoredAt: string;
}

/** Individual repo restoration result */
export interface RepoRestoreResult {
  /** Repo key */
  readonly repoKey: string;
  /** Whether restoration succeeded */
  readonly succeeded: boolean;
  /** Files restored */
  readonly restoredFiles: string[];
  /** Error message if failed */
  readonly error?: string;
  /** Strategy used */
  readonly strategy: "checkout_ours" | "stash_drop" | "worktree_remove";
}

/** Workspace port interface */
export interface WorkspacePort {
  /**
   * Inspect a Git repository and return its current state
   * @param path - Path to repository (will be resolved to canonical root)
   * @param role - Repository role for context
   * @returns Repository inspection result
   */
  inspectRepo(path: string, role?: RepositoryRole): Promise<RepoInspection>;

  /**
   * Prepare workspaces for a task
   * Creates worktrees for primary/target repos, uses source for reference repos
   * @param input - Preparation input
   * @returns Set of prepared workspaces
   */
  prepareTaskWorkspaces(input: PrepareWorkspacesInput): Promise<WorkspaceSet>;

  /**
   * Validate a workspace set before use
   * Checks canonical paths, repo collisions, duplicate paths, and fingerprints
   * @param set - Workspace set to validate
   * @throws Error if validation fails
   */
  validateWorkspaceSet(set: WorkspaceSet): Promise<void>;

  /**
   * Capture changes in all workspaces
   * Uses Git-authoritative change detection
   * @param set - Workspace set to capture changes from
   * @returns Set of captured changes
   */
  captureChanges(set: WorkspaceSet): Promise<ChangeSet>;

  /**
   * Restore unauthorized changes without destructive reset
   * Only restores files that were modified without authorization
   * @param input - Restoration input
   * @returns Restoration result
   */
  restoreUnauthorizedChanges(input: RestoreUnauthorizedInput): Promise<RestoreResult>;
}

/** Error thrown when workspace validation fails */
export class WorkspaceValidationError extends Error {
  constructor(
    message: string,
    public readonly reason: WorkspaceValidationReason
  ) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

export type WorkspaceValidationReason =
  | "not_a_git_repo"
  | "dirty_working_tree"
  | "base_sha_mismatch"
  | "path_traversal_detected"
  | "symlink_escape"
  | "repo_collision"
  | "duplicate_path"
  | "protected_fingerprint_mismatch"
  | "worktree_creation_failed"
  | "invalid_repo_role";
