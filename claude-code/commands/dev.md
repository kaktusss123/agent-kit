---
description: Task implementation — resolve the task, dispatch RepoOwner subagents into managed worktrees, review and integrate
argument-hint: "[task]"
---

Enter implementation mode for: $ARGUMENTS. If that is empty, use the goal already agreed in this conversation; if there is none, ask the user what to work on before doing anything else.

Main is the task controller: it owns task intent, user decisions, orchestration, review, and integration. Repository mutation is performed by RepoOwners.

Work per `skill://git-task` (Claude Code contracts: its `references/claude-code/`):

- Resolve or continue the task identity and reuse the existing canonical managed worktree(s) (`agent-kit task status`, `agent-kit task ensure`).
- Load and follow `SPEC.md` from the task workspace when it exists.
- Dispatch exactly one RepoOwner per writable repository — an Agent-tool subagent whose assignment names that repository's managed worktree as its only home (parallel for independent repositories, dependency-ordered otherwise). Main does not edit task repositories itself.
- After each owner returns, read the objective git facts with `agent-kit task status` before trusting its report; a question from an owner is answered by continuing the same agent with SendMessage. Repair through a fresh owner that first inspects current state.
- After each final-verified committed candidate, make the independent-review decision explicitly: Main's own review suffices for local, low-risk changes; substantial candidates expect an independent fresh-context reviewer subagent (policy: `skill://git-task`).

Inside owners: `skill://implementation`, `skill://tdd`, `skill://verification-design` as the work demands; checkpoints per `skill://git-commit` through `agent-kit task commit`. Finish with evidence, or a specific blocker.
