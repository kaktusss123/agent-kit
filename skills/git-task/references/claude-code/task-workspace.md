# Task workspace runtime (Claude Code)

Claude Code binding of the same deterministic core the Pi extension uses (`extensions/task-workspace`). Statuses, refusals, and guarantees are identical to `references/task-workspace.md`; only the call surface differs. The model calls the CLI and reads its JSON; it never reimplements the mechanics.

## Calling the runtime

`agent-kit task <op> '<json params>'` through Bash (the installer puts `agent-kit` on the Bash PATH via `~/.local/bin/agent-kit`; the plugin's `bin/` is not a guaranteed PATH entry — use `~/.local/bin/agent-kit`; if `agent-kit` is missing from PATH, see "Without the guard" below; `-` instead of the JSON reads params from stdin). Params are the Pi tool parameters verbatim, snake_case keys:

| Pi tool | CLI |
| --- | --- |
| `task_status(path?)` | `agent-kit task status '{"path": "…"}'` (params optional) |
| `ensure_task_repo(branch, source_path, base_ref?, remote?, task?, slot?)` | `agent-kit task ensure '{"branch": "…", "source_path": "…"}'` |
| `remove_task_lane(task, path)` | `agent-kit task remove-lane '{"task": "…", "path": "…"}'` |
| `teardown_task_repo(task)` | `agent-kit task teardown '{"task": "…"}'` |
| session current task (read-only) | `agent-kit task current '{"cwd": "<abs>", "selections": [{"task": "…", "worktree": "…"}]}'` — the `task_current` projection (managed `cwd` wins, else last selection; `selections` = successful `ensure` results in order; no owners) |
| `checkpoint_commit(…)` | `agent-kit task commit '{…}'` — see `skills/git-commit/references/claude-code/checkpoint.md` |

Output is one JSON object on stdout. Exit code 0 means the operation produced a meaningful status — including refusals such as `base_selection_required`, `remote_selection_required`, `branch_in_use`, which are answers, not failures. Exit code 1 is a tool error (`status: "error"`, `message`); exit code 2 is a usage error (bad JSON, missing required parameter) and nothing ran. The session cwd is the Bash cwd; pass absolute paths.

Statuses, required reactions, and guarantees per operation: `references/task-workspace.md` (environment, `task_status`, `ensure_task_repo`, secondary lanes). Everything stated there holds for the CLI, because it is the same code.

## Mutation guard

The agent-kit plugin applies the same policy as Pi through Claude Code hooks:

- A `SessionStart` hook arms the git PATH shim for every Bash command of the session and its subagents (via `CLAUDE_ENV_FILE`): mutating git on the primary checkout of a repository that has managed worktrees is blocked with the worktree paths, `--no-verify` is blocked everywhere, `--git-dir`/`--work-tree` redirection blocks local mutations; read-only git and `push` pass. Same documented bypasses as in Pi (absolute git path, `sudo`, inline `PATH=`); it is routing protection, not a sandbox.
- A `PreToolUse` hook denies `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of tracked primary-checkout files of such a repository (ignored untracked files stay writable) and of `.git` metadata, naming the managed worktrees. This guard covers only those edit tools: writes performed through Bash (`sed -i`, `cp`, redirection, scripts) are not intercepted and are covered only by the RepoOwner contract and the routing rules below.
- Without its environment (plugin not loaded, managed `allowManagedHooksOnly`, checkout without the task-workspace CLI) the guard fails open and Bash behaves stock.

A guard denial is a routing failure: address the managed worktree instead; never repeat the mutation through another tool, `cp`, `sed`, Python, or another agent.

## Without the guard

Managed Claude Code settings can forbid non-managed hooks (`allowManagedHooksOnly`); then the plugin loads but its hooks never run. Check once per session: `[ -n "$AGENT_KIT_POLICY" ] && echo guarded || echo unguarded`. When unguarded, the routing rules still hold — only the mechanical enforcement is gone, so apply them yourself (and put them in every owner assignment):

- Before every `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, the target is an absolute path inside the managed worktree. A primary-checkout path of a repository with managed worktrees is a routing error even when nothing stops it — correct the path, do not write there.
- Every mutating git command is `git -C <managed worktree> …`; never a bare `git` that depends on the Bash cwd, never `--git-dir`/`--work-tree`/`GIT_DIR`.
- Commits go only through `agent-kit task commit`: it still refuses primary-checkout commits and secret-like paths and always runs hooks. Never raw `git commit`, never `--no-verify`.
- Before reporting work as done, `agent-kit task status` and `git -C <primary checkout> status --short`: the primary checkout of the task repository has no new changes from this task.

## Sandboxed Bash

When Bash runs in a sandbox that cannot write the task root (`ensure`/`remove-lane`/`teardown` fail with `EPERM`/`Operation not permitted` on a path under it), do not retry, relocate the task root, or create worktrees by hand. Hand the user the exact `! agent-kit task <op> '<json>'` command, then continue from its JSON output. Status, commit, and work inside an existing worktree are affected only if the sandbox forbids that worktree too; report which path was refused.

## Mutation in subagents

`agent-kit task status` / `ensure` are Main's calls. Repository mutation inside the managed worktree is done by RepoOwner subagents per `references/claude-code/repo-owners.md`.
