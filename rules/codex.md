# Codex host binding

Read this binding before the shared rules below: their Pi-only names have the
Codex meaning defined here. These instructions target Codex CLI 0.166.0. Resolve
`skill://<name>` as `$HOME/.agents/skills/<name>/SKILL.md`; read referenced files
relative to that skill directory. Shared skills do not move with `CODEX_HOME`.

- Use `$spec` and `$dev` for workflow entrypoints. Do not use deprecated prompts.
- Before any Git task work, read the Codex binding at
  `$HOME/.agents/skills/git-task/references/codex/workflow.md` BEFORE any Pi
  runtime reference. It replaces Pi-specific workspace and delegation mechanics.
- Before a checkpoint, read
  `$HOME/.agents/skills/git-commit/references/codex/checkpoint.md` instead of the
  Pi checkpoint reference. Use `agent-kit task commit` over the shared core.
- Delegate through native `spawn_agent`, `wait_agent`, `send_input`, `resume_agent`, and `close_agent`
  only when available (v2 catalogs use `send_message` / `followup_task` instead
  of v1 messaging/continuation; use the actual exposed schema). There is no Pi workspace-spawn protocol, report tool,
  automatic deadline, readiness signal, ownership envelope, or model-role binding.
  Missing delegation blocks implementation: report it, never edit the primary.
- Treat every child as read-only unless explicitly assigned the sole repository
  owner role and an absolute managed worktree. Main never competes for writes.
- Installed hooks are not proof of active protection. Review/trust non-managed
  hooks explicitly through `/hooks`; do not edit config or bypass trust yourself.
  Disabled/untrusted hooks, host errors/timeouts, absolute Git executables, shell
  environment resets and arbitrary shell file writes can bypass routing guards.
  Always route task writes manually to managed worktrees; never bypass a block.
