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

## Subagents

- Roles map to Claude Code agents: `explore` → `Explore` (agent-kit override, cheap, read-only); `owner` → `repo-owner` (RepoOwners only); `review` → `general-purpose` with `model: opus`; `helper` → `general-purpose` without `model`.
- Agent definitions pin aliases (`haiku`, `sonnet`), not model IDs. A machine remaps an alias globally (not per role) through `env` in `~/.claude/settings.json`: `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`.
- Never pass `model` to an agent whose definition sets its own `model`; the parameter overrides it.
- Add a new agent type only when a role needs its own system prompt or tool set, never for price or effort alone.
- Do not use the haiku tier as the sole authority for root-cause analysis, security review, or design decisions.
- Explore returns bounded findings. Bulk verbatim extraction (whole files, long logs) is Main's job; do not delegate it.

## Session mechanics

- The skill listing is frozen at session start. After a task that adds or renames a skill, run `/reload-skills` before relying on it.
- A Bash call that exceeds the timeout moves to the background and notifies you on completion. Do not arm Monitors for a call your own tool will report.
