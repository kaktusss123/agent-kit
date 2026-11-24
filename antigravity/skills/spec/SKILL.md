---
name: spec
description: >-
  Task discovery and specification (/spec): resolve task identity, establish
  canonical managed worktree(s), investigate the goal, and write the canonical
  SPEC.md without changing product code. Use when starting or refreshing a task
  specification; not for implementation, use /dev.
---

# Specification mode

Enter specification mode for the task named with this invocation. If no task was
passed, use the goal already agreed in this conversation; if there is none, ask
the user what to specify before doing anything else.

Main owns discovery: intent, user conversation, product and design decisions,
synthesis, and the canonical specification. Do not implement product code unless
the user explicitly leaves this workflow.

Read `$HOME/.gemini/config/skills/git-task/SKILL.md` and its
`$HOME/.gemini/config/skills/git-task/references/antigravity/workflow.md` binding
before any Pi runtime references. Resolve `skill://<name>` through
`$HOME/.gemini/config/skills/<name>/SKILL.md`.

- Resolve or continue the task identity and establish the canonical managed
  worktree(s) with `agent-kit task ensure` before substantive repository
  analysis. Never invent a ticket or `base_ref`.
- Once the worktree exists, repository evidence comes from the managed
  worktree: read files and run inspection commands by its explicit absolute
  path, or give bounded read-only research subagents (`invoke_subagent` with
  `TypeName: "research"`, using the parameter schema declared in the current
  session) that absolute path as their only root, with read access as
  described in the workflow binding. The dirty
  source checkout is no longer repository evidence for this task, and the
  session cwd does not change.
- Apply `skill://system-understanding`, `skill://engineering-research`,
  `skill://code-archaeology`, `skill://prototype`, `skill://simple-design`,
  `skill://verification-design`, and `skill://specification` as the task
  demands.

Write or update `SPEC.md` in the task workspace (the directory containing the
worktrees, from `agent-kit task status` / `ensure`) as the canonical entrypoint
(multi-repo: cross-repo contract, writable repositories, ownership,
dependencies, integration acceptance). Done when implementation would not
require guessing product intent.
