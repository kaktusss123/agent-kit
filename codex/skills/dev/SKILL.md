---
name: dev
description: "Codex implementation entrypoint ($dev): reuse managed worktrees, dispatch one repository owner per writable repository, then review and integrate committed verified candidates. Use when implementing an agreed task or specification; not for specification, use $spec."
---

# Implementation mode

Use the named/agreed task; ask if there is none. Read
`$HOME/.agents/skills/git-task/SKILL.md` and its `$HOME/.agents/skills/git-task/references/codex/workflow.md`
binding first. Resolve `skill://<name>` through
`$HOME/.agents/skills/<name>/SKILL.md`; no Pi mechanics are required.

- Reuse canonical managed worktrees through `agent-kit task status` / `ensure`;
  load the task's `SPEC.md` when present. Never use the primary for task writes.
- Dispatch exactly one repository owner per writable repository through native
  `spawn_agent`; parallelize independent repositories, respect dependencies.
  Main never edits task repositories. Missing delegation blocks implementation.
- Assign the absolute worktree, scope, contract/base, required skills/checks and
  checkpoint plus AFTER-COMMIT verification. No Pi lease or deadline is supplied.
- Continue the same active thread with `send_input` and `wait_agent`; a timeout
  is not settlement. Inspect state before replacing an owner. Close finished
  threads with `close_agent`; use `resume_agent` only for a closed thread.
- Read settled Git facts yourself through `agent-kit task status`, `git -C
  <worktree> rev-parse HEAD`, and `git -C <worktree> status --short`. Accept done
  only from a clean committed candidate with post-commit verification evidence.
- Make an explicit own-review versus independent fresh-context reviewer decision
  per `skill://git-task` / `skill://code-review`; substantial changes normally
  need independent read-only review. Repair uses a fresh owner inspecting current
  state, not Main or the reviewer editing the candidate.
- Checkpoints use `agent-kit task commit` and
  `$HOME/.agents/skills/git-commit/references/codex/checkpoint.md`. No push, installation or
  deployment follows implicitly from a completed implementation.
