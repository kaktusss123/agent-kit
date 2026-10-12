# agent-kit in Claude Code

agent-kit skills and AGENTS.md are written for the Pi harness. In Claude Code:

- `skill://<name>` means the skill `<name>`; load it with the Skill tool.
- "the ask tool" / `ask` means `AskUserQuestion`. Subagents cannot ask the user; they return the open question to the caller.
- The agent-kit task-workspace runtime is not available here: there is no `task_status`, `ensure_task_repo`, `remove_task_lane`, `checkpoint_commit`, `subagent` workspace spawn, RepoOwner, or git mutation guard. Rules that depend on them (primary-checkout ban, RepoOwner routing, `checkpoint_commit`, deferred hooks) are inactive. Do not emulate that runtime by hand; work in the current checkout unless the user directs otherwise. Skills `git-task` and `git-commit` are not installed.
- Still in force: never invent a ticket or `base_ref`; never commit with `--no-verify`; a blocked or denied action is never authorization to reach the same result another way.
