# agent-kit in Claude Code

agent-kit skills and AGENTS.md are written for both Pi and Claude Code; Pi tool names in them map as follows:

- `skill://<name>` means the skill `<name>`; load it with the Skill tool.
- "the ask tool" / `ask` means `AskUserQuestion`. Subagents cannot ask the user; they return the open question to the caller.
- The task-workspace runtime is `agent-kit task <op>` through Bash (`status`, `ensure`, `remove-lane`, `teardown`, `commit`; JSON params and output). Contracts: `git-task` → `references/claude-code/task-workspace.md` and `references/claude-code/repo-owners.md`; `git-commit` → `references/claude-code/checkpoint.md`. Each binds the same contract as the Pi reference beside it.
- The git mutation guard and the primary-checkout write guard come from the agent-kit plugin hooks. A denial names the managed worktree; it is a routing failure, never permission to reach the same result another way. Managed settings may forbid these hooks (`allowManagedHooksOnly`): if `$AGENT_KIT_POLICY` is unset in Bash, the session is unguarded — follow "Without the guard" in `git-task` `references/claude-code/task-workspace.md`; the routing rules apply unchanged, you enforce them.
- A RepoOwner is an Agent-tool subagent rooted by explicit path in its managed worktree; there is no `subagent` workspace spawn, readiness handshake, or enforced deadline. Main reads git facts with `agent-kit task status`.
- `/spec` and `/dev` are Claude Code commands with the same workflow as in Pi.
- If `agent-kit` is not on the Bash PATH (plugin not loaded, `bun` missing), the runtime is unavailable: report it instead of emulating the runtime by hand.
- Sandboxed Bash: when Bash runs in a sandbox, operations that need the network or credentials outside it — `git push`/`fetch` over SSH, `gh`, `glab` — fail there. Do not attempt them, retry them, or route around the sandbox. Finish everything local (commit, PR/MR body file), then hand the user one combined `! <command>` that runs the remaining steps. Without a sandbox, run them directly.
- Always: never invent a ticket or `base_ref`; never commit with `--no-verify`.
