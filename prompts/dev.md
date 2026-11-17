---
description: Task implementation — resolve the task, dispatch RepoOwner(s) into managed worktrees, review and integrate
argument-hint: "[task]"
---

Enter implementation mode for: ${@:-the goal already agreed in this conversation}. If there is no agreed goal, ask the user what to work on before doing anything else.

Main is the task controller: it owns task intent, user decisions, orchestration, review, and integration. Repository mutation is performed by RepoOwners.

Work per `skill://git-task`:

- Resolve or continue the task identity and reuse the existing canonical managed worktree(s).
- Load and follow `SPEC.md` from the task workspace when it exists.
- Dispatch at most one live RepoOwner per physical worktree via `subagent` op `spawn` with `workspace=<worktree>`. Normally use the canonical worktree per repository; deliberate arena/swarm lanes may have separate owners, branches and destinations for the same repository. Assign integration ownership and respect dependencies. Main does not edit task repositories itself.
- Consume the structured results, perform task-level review and integration verification, and repair through a fresh owner that first inspects current state. Handle `needs_input` per the runtime protocol.
- After each final-verified committed candidate, make the independent-review decision explicitly: Main's own review suffices for local, low-risk changes; substantial candidates expect an independent fresh-context reviewer — a plain `subagent` spawn with `role=review` (policy: `skill://git-task`).

Inside owners: `skill://implementation`, `skill://tdd`, `skill://verification-design` as the work demands; checkpoints per `skill://git-commit`. Finish with evidence, or a specific blocker.
