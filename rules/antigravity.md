# Antigravity host binding

Read this binding before the shared rules below: Pi and Claude Code names in
`AGENTS.md` and `skills/` map onto Antigravity's native tools as follows.

- `skill://<name>` resolves to `$HOME/.gemini/config/skills/<name>/SKILL.md`;
  read it and any referenced files relative to that skill directory using
  `view_file`.
- `/spec` and `/dev` are Antigravity skills (`spec` and `dev`) with the same
  workflow as in Pi and Claude Code.
- "the ask tool" / `ask` maps to `ask_question` for structured choices, or a
  direct plain-text question for trivial yes/no clarifications. Subagents
  cannot ask the user directly; they return a `blocked` report naming the open
  question.
- `web_search` maps to `search_web`.
- Before any Git task work, read the Antigravity binding at
  `$HOME/.gemini/config/skills/git-task/references/antigravity/workflow.md`
  BEFORE any Pi runtime reference. It replaces Pi-specific workspace and
  delegation mechanics.
- Before a checkpoint commit, read
  `$HOME/.gemini/config/skills/git-commit/references/antigravity/checkpoint.md`
  instead of the Pi checkpoint reference. Commit only through
  `agent-kit task commit` over the shared core.
- The task-workspace runtime is `agent-kit task <op> '<json>'` through
  `run_command` (`status`, `ensure`, `remove-lane`, `teardown`, `commit`,
  `current`). Follow the workflow binding for scoped worktree access and
  native per-command approval when a task operation needs access outside the
  sandbox. If `agent-kit` is missing from `PATH`, report it instead of
  emulating the runtime by hand.
- Subagent delegation uses `define_subagent`, `invoke_subagent`,
  `send_message`, and `manage_subagents`:
  - `explore` / read-only research and independent reviewers -> built-in
    `research` subagent (read-only), bounded to an explicit absolute managed
    worktree path in the prompt.
  - `owner` (RepoOwner) -> define `repo-owner` once per session via
    `define_subagent` (`enable_write_tools: true`). Verify worktree access
    before dispatching the owner in `invoke_subagent`'s `Subagents` array
    with `Workspace: "inherit"`.
  - Continue a waiting or blocked owner with `send_message` using its
    conversation ID as `Recipient` and the answer as `Message`.
  - There is no Pi ownership lease, readiness handshake, enforced deadline, or
    automatic `git_facts` envelope. Main enforces at most one live owner per
    physical worktree and reads settled Git facts itself.
- Routing guard boundary: the `agent-kit` plugin's `PreToolUse` hook guards
  Antigravity file-writing tools (`write_file`, `edit_file`, `write_to_file`,
  `replace_file_content`, `multi_replace_file_content`) against writes to a
  primary checkout with managed worktrees and blocks raw `git ... --no-verify`
  in `run_command`. Arbitrary shell writes and mutating `git` commands inside
  `run_command` are not intercepted by a PATH shim (to preserve Antigravity's
  terminal sandbox). Always use absolute managed worktree paths, `git -C
  <managed-worktree>`, and `agent-kit task commit`; verify the primary checkout
  stays unchanged. A guard denial is a routing failure, never permission to
  reach the same result another way.
