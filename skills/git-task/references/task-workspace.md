# Task workspace runtime (Pi)

Deterministic contract of the `task-workspace` Pi extension. Every guarantee below is enforced by extension code, not by model discipline. The model calls the tools and reads structured results; it never reimplements the mechanics.

## Environment

- The task-root location is resolved deterministically by the extension (`AGENT_TASK_ROOT` override honored; otherwise `~/.agent-kit/tasks`). The model never constructs workspace paths from branch names — call `task_status` and use the reported absolute paths.

## task_status

Classifies a path and reports current Git facts.

- Input: `path` (optional; defaults to the session cwd).
- Output: classification of the path (`PRIMARY_CHECKOUT`, `MANAGED_TASK_WORKTREE`, …) plus every managed task workspace with its key (the workspace directory name, the flattened branch), repos, paths, branches, HEAD, upstream, canonical-or-lane kind, slot, dirty paths, and artifacts.
- Use it to discover existing task workspaces before creating anything, and to check which checkout a branch is attached to.

## ensure_task_repo

Attaches a source repository to the task workspace as a git worktree.

Inputs the model chooses deliberately:

- `branch` — task branch name; the canonical call's task identity. With `slot`, the lane's own branch.
- `source_path` — the source git repository to attach.
- `base_ref` — only per the base-selection policy in SKILL.md; omit otherwise.
- `remote` — only when auto-detection is wrong or ambiguous. An explicit name must identify a configured remote.
- `task` + `slot` — secondary lane inside the canonical workspace; `task` is required with `slot` and ignored otherwise.

Meaningful results and the required reaction:

- `reused`, `attached`, `created`, `created_from_remote` → proceed. The result carries self-describing `inputRepo` facts (input path, git root, classification, branch, HEAD, dirty state). The input checkout is read-only for the task — never commit, reset, or fetch into it.
- `base_selection_required`, `remote_selection_required` → the runtime refuses to guess product branching semantics; ask the user (see SKILL.md) and retry with an explicit value. For a local-only repository with no task branch, `base_selection_required` names the missing local `base_ref`; supplying it creates without a fetch.
- `branch_in_use` → another worktree already holds the branch; report which one and ask. Never force, detach, or remove it.

Guarantees: an existing local task branch is attached before remote selection or fetch; the runtime never forces, resets, or detaches anything; the same task identity resolves to the same workspace location for every session; protected default development branches (`main`, `master`, `develop`) are refused as task branches — canonical and lane calls alike — before anything is created or changed; all state lives in git (branches + worktrees), so there are no manifest files to corrupt or migrate.

## Secondary lanes

`remove_task_lane(task, path)` removes one clean secondary lane from its managed workspace. Meaningful results: `removed`; `lane_rejected` (canonical worktrees and other invalid targets are refused); `lane_dirty` (uncommitted changes — clean up first); `worktree_remove_failed` / `branch_delete_blocked` (git refused; report, never force). Both removal and branch deletion are non-force operations.

## Mutation guard (workspace relationship)

While a task workspace exists for a repository, the extension classifies the target path of every `write` and `edit` call, and enforces git policy where git actually executes: the bash tool is overridden so every shell child gets a PATH shim for `git` (`extensions/task-workspace/shim/`). Each real git invocation reports its post-`cd` working directory and exact argv to the policy module, which classifies it with the shared subcommand/flag tables: read-only commands pass, `git push` (an external side effect) passes, and local/ref mutations under the task root (managed worktree), in another linked worktree, under a temporary root, or outside git pass. The primary checkout of a repository that HAS managed worktrees is blocked, naming the worktrees. `--no-verify` on a mutating command is blocked everywhere (recovery path: `checkpoint_commit` with `deferred_hook` evidence), and `--git-dir`/`--work-tree`/`GIT_DIR`/`GIT_WORK_TREE` redirection blocks local mutations — use `git -C <worktree>` instead.

The guard is routing protection, not a sandbox; external side effects such as `push` are outside this policy. Documented bypasses: absolute git paths (`/usr/bin/git`), `sudo`/secure_path, and inline `PATH=` reassignment. The gain over command-string inspection: git inside project scripts and makefiles IS caught, because it resolves through PATH, and prose that merely contains the word "git" can never trip the guard. A guard block means the command was addressed at the wrong place, and the fix is to address the managed worktree. Primary-checkout commits are separately rejected by `checkpoint_commit` (see `skills/git-commit/references/checkpoint.md` for that contract).
