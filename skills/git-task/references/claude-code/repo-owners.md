# Repository owners (Claude Code)

Claude Code has no workspace-mode `subagent` runtime (readiness handshake, enforced deadline, terminal envelope). The RepoOwner policy in SKILL.md stays; its Pi mechanics map onto Claude Code primitives as below. Where SKILL.md names a Pi mechanic, use the mapping here.

## Dispatching an owner

A RepoOwner is an Agent-tool subagent (`general-purpose`, or a custom agent with full tools) dispatched by Main after `agent-kit task ensure` returned the worktree. The assignment carries:

- the absolute managed worktree path as the owner's only home: every file path absolute under it, every Bash command run as `cd <worktree> && …` (a subagent's Bash cwd is not guaranteed to persist between calls);
- intent, the `SPEC.md` path when it exists, the worker report contract from `references/repo-owners.md`, and the instruction to change only this repository;
- commits only through `agent-kit task commit` (`skills/git-commit/references/claude-code/checkpoint.md`).

Do not use `isolation: worktree` for owners: it creates a separate Claude-managed worktree on its own branch instead of the task worktree. Model choice: omit the model unless the user chose one; `modelClass=smart` for an independent reviewer means the strongest available model.

Parallel owners for independent repositories are parallel Agent calls in one message; dependent owners are dispatched in dependency order.

## During a run and questions

There is no `needs_input` suspension: a subagent cannot ask the user. An owner that hits a decision it cannot resolve stops and returns a `blocked` report naming the question. Main resolves it from its own context or asks the user, then continues the SAME owner with `SendMessage` (its context is intact) — never a fresh dispatch for a pending question. There is no enforced deadline; size the assignment, and stop a runaway owner with `TaskStop`.

## Settled-state verification (replaces `git_facts`)

After an owner returns, Main reads the objective facts itself — never asks the model which commit it produced:

```
agent-kit task status '{"path": "<worktree>"}'
```

The matching `taskWorkspaces[].repos[]` entry carries `branch`, `headSha`, `upstream`, and `dirty` (staged/unstaged). A `done` report is accepted only when HEAD moved to a new commit on the task branch and the tree is clean (untracked non-ignored files count as dirt); otherwise treat it as `blocked` (`done_rejected`) and repair through a fresh owner that first inspects the worktree.

## Report, review, repair

The worker report contract, done-means-committed-and-verified ordering, review, and repair rules are those of `references/repo-owners.md` and SKILL.md. An independent reviewer is a fresh Agent-tool subagent rooted (by explicit path) at the worktree, read-only, never the implementing owner.
