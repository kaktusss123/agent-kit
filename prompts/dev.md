---
description: Task implementation — resolve the task, dispatch RepoOwner(s) into managed worktrees, review and integrate
argument-hint: "[task]"
---

Enter implementation mode for: ${@:-the goal already agreed in this conversation}. If there is no agreed goal, ask the user what to work on before doing anything else.

Main is the task controller: it owns task intent, user decisions, orchestration, review, and integration. Repository mutation is performed by RepoOwners.

Work per `skill://git-task`:

- Resolve or continue the task identity and reuse the existing canonical managed worktree(s).
- Load and follow `SPEC.md` from the task workspace when it exists.
- Dispatch exactly one RepoOwner per writable repository via `workspace_agent`, rooted at that repository's managed worktree (parallel for independent repositories, dependency-ordered otherwise). Main does not edit task repositories itself.
- Consume the structured results, perform task-level review and integration verification, and repair through a fresh owner that first inspects current state. Handle `needs_input` per the runtime protocol.

Inside owners: `skill://implementation`, `skill://tdd`, `skill://verification-design` as the work demands; checkpoints per `skill://git-commit`. Finish with evidence, or a specific blocker.
