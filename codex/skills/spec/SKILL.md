---
name: spec
description: "Codex specification entrypoint ($spec): establish task identity and managed worktrees, investigate the goal, and write the canonical specification. Use when starting or refreshing a task specification; not for implementation, use $dev."
---

# Specification mode

Use the goal named with this invocation or already agreed in the conversation;
ask if there is none. Read `$HOME/.agents/skills/git-task/SKILL.md` and its
`skills/git-task/references/codex/workflow.md` binding before any Pi runtime references.
Resolve `skill://<name>` through `$HOME/.agents/skills/<name>/SKILL.md`.

Main owns discovery, user decisions and the canonical specification. Establish
the canonical managed worktree with `agent-kit task ensure` before substantive
analysis; never invent ticket authority or a base. Research agents use native
`spawn_agent`, are read-only by assignment and are bounded to an absolute
managed worktree. No Pi workspace spawn or automatic Git facts are available.

Apply `skill://simple-design`, `skill://verification-design` and
`skill://specification` as appropriate. Write `SPEC.md` beside the worktrees in
the task workspace reported by the CLI, preserving repository ownership and
cross-repository dependencies. Resolve material decisions with the user; do not
start implementation or change repository files in specification mode.
