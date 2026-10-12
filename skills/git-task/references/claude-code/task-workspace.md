# Task workspace runtime (Claude Code)

Claude Code binding of the same deterministic core the Pi extension uses (`extensions/task-workspace`). Statuses, refusals, and guarantees are identical to `references/task-workspace.md`; only the call surface differs. The model calls the CLI and reads its JSON; it never reimplements the mechanics.

## Calling the runtime

`agent-kit task <op> '<json params>'` through Bash (the agent-kit plugin puts `agent-kit` on the Bash PATH; `-` instead of the JSON reads params from stdin). Params are the Pi tool parameters verbatim, snake_case keys:

| Pi tool | CLI |
| --- | --- |
| `task_status(path?)` | `agent-kit task status '{"path": "…"}'` (params optional) |
| `ensure_task_repo(branch, source_path, base_ref?, remote?, task?, slot?)` | `agent-kit task ensure '{"branch": "…", "source_path": "…"}'` |
| `remove_task_lane(task, path)` | `agent-kit task remove-lane '{"task": "…", "path": "…"}'` |
| `teardown_task_repo(task)` | `agent-kit task teardown '{"task": "…"}'` |
| `checkpoint_commit(…)` | `agent-kit task commit '{…}'` — see `skills/git-commit/references/claude-code/checkpoint.md` |

Output is one JSON object on stdout. Exit code 0 means the operation produced a meaningful status — including refusals such as `base_selection_required`, `remote_selection_required`, `branch_in_use`, which are answers, not failures. Exit code 1 is a tool error (`status: "error"`, `message`); exit code 2 is a usage error (bad JSON, missing required parameter) and nothing ran. The session cwd is the Bash cwd; pass absolute paths.

Statuses, required reactions, and guarantees per operation: `references/task-workspace.md` (environment, `task_status`, `ensure_task_repo`, secondary lanes). Everything stated there holds for the CLI, because it is the same code.

## Mutation guard

The agent-kit plugin applies the same policy as Pi through Claude Code hooks:

- A `SessionStart` hook arms the git PATH shim for every Bash command of the session and its subagents (via `CLAUDE_ENV_FILE`): mutating git on the primary checkout of a repository that has managed worktrees is blocked with the worktree paths, `--no-verify` is blocked everywhere, `--git-dir`/`--work-tree` redirection blocks local mutations; read-only git and `push` pass. Same documented bypasses as in Pi (absolute git path, `sudo`, inline `PATH=`); it is routing protection, not a sandbox.
- A `PreToolUse` hook denies `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of tracked primary-checkout files of such a repository (ignored untracked files stay writable) and of `.git` metadata, naming the managed worktrees.
- Without its environment (plugin disabled, `bun` missing) the guard fails open and Bash behaves stock.

A guard denial is a routing failure: address the managed worktree instead; never repeat the mutation through another tool, `cp`, `sed`, Python, or another agent.

## Mutation in subagents

`agent-kit task status` / `ensure` are Main's calls. Repository mutation inside the managed worktree is done by RepoOwner subagents per `references/claude-code/repo-owners.md`.
