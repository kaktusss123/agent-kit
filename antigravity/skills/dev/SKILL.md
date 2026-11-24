---
name: dev
description: >-
  Task implementation (/dev): reuse canonical managed worktree(s), load
  SPEC.md, dispatch one RepoOwner subagent per physical worktree, verify
  settled Git facts, and review/integrate committed candidates. Use when
  implementing an agreed task or specification; not for specification, use /spec.
---

# Implementation mode

Enter implementation mode for the task named with this invocation. If no task
was passed, use the goal already agreed in this conversation; if there is none,
ask the user what to work on before doing anything else.

Main is the task controller: it owns task intent, user decisions,
orchestration, review, and integration. Repository mutation is performed by
RepoOwner subagents rooted in managed worktrees. Main does not edit task
repositories itself.

Read `$HOME/.gemini/config/skills/git-task/SKILL.md` and its
`$HOME/.gemini/config/skills/git-task/references/antigravity/workflow.md` binding
first. Resolve `skill://<name>` through
`$HOME/.gemini/config/skills/<name>/SKILL.md`.

- Resolve or continue the task identity and reuse the existing canonical
  managed worktree(s) (`agent-kit task status`, `agent-kit task ensure`). Load
  and follow `SPEC.md` from the task workspace when it exists. Never use the
  primary checkout for task writes.
- Verify or request scoped access to each managed worktree and its Git
  metadata before dispatch, following the workflow binding. Define
  `repo-owner` once per session via `define_subagent` with write tools
  enabled, and dispatch via `invoke_subagent` with `TypeName: "repo-owner"`
  and `Workspace: "inherit"` using the parameter schema declared in the current
  session. Dispatch at most one live RepoOwner per physical worktree. Normally
  use the canonical worktree per repository. Deliberate arena/swarm lanes may
  have separate owners, branches, and outputs for one repository. Assign
  integration ownership and respect dependencies.
- Give each owner its absolute managed worktree path, allowed repository,
  intent / `SPEC.md` path, base SHA, required skills/checks, and checkpoint
  plus AFTER-COMMIT verification requirements (`agent-kit task commit` per
  `$HOME/.gemini/config/skills/git-commit/references/antigravity/checkpoint.md`).
- If an owner returns a `blocked` question, resolve it in Main or ask the user,
  then continue the SAME owner via `send_message` using its conversation ID
  as `Recipient` and the answer as `Message`.
- After each owner returns, read settled Git facts yourself before trusting its
  report: `agent-kit task status`, `git -C <worktree> rev-parse HEAD`, and
  `git --no-optional-locks -C <worktree> status --short`. Accept `done` only
  from a clean committed candidate verified after that commit.
- Make an explicit own-review versus independent fresh-context reviewer
  decision per `skill://git-task` and `skill://code-review`: Main's own review
  suffices for local, low-risk changes; substantial candidates expect a fresh
  read-only `research` reviewer subagent rooted at the managed worktree. Repair
  through a fresh `repo-owner` that first inspects current state.

Finish with evidence or a specific blocker. No push, installation, or
deployment follows implicitly from a completed implementation.
