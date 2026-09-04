---
description: "Manager-only development workflow for large or multi-stage engineering tasks. Main owns the goal and context, decomposes only when useful, delegates implementation through checkpoint + fresh-verification loops, repairs failed slices instead of restarting, and finishes with task-level acceptance."
---

# Dev workflow

Act as the manager of the whole engineering task.

Task: $ARGUMENTS

If the task is empty, use the goal already agreed in this conversation; if there is none, ask the user what to work on before doing anything else.

Keep task-level context in main and delegate implementation details. Do not edit product code from main while this workflow is active. Main may inspect code, diffs, commits, tests, and agent outputs to make management decisions.

## Plan the execution

Understand the requested outcome and the current repository before decomposing work. Use `skill://system-understanding`, `skill://blast-radius`, `skill://codebase-design`, or `skill://engineering-research` when the task requires them. Decompose only when it is useful; small tasks do not need slices or delegation.

Split the task into the smallest coherent slices that can be implemented and verified independently. Avoid artificial stages that exist only to make the workflow look structured.

Fan out only genuinely independent work. If two agents would inspect or modify substantially overlapping code or solve the same unknown, serialize them unless deliberate independent review is the goal.

## Run every changing slice through the checkpoint loop

For each slice:

1. Delegate implementation with the governing intent, boundaries, known decisions, relevant evidence, and acceptance for that slice. The implementer should use `skill://implementation` and any domain skills it needs.
2. Require the implementer to inspect its diff and run cheap focused feedback before checkpointing.
3. Create a checkpoint commit using `skill://git-commit`.
4. Verify the exact committed state in fresh context using `skill://change-verification`.
5. If verification fails, send the concrete findings to an implementation pass that repairs the existing state, create a new commit, and verify again.
6. Escalate to the user only when repository reality conflicts with product intent or a repair requires a material decision.

A failed attempt is not a reason to restart the whole task. Reuse the repository state, inspect partial work, and converge from what exists.

## Keep main context clean

Track only what is needed to steer the large task:

- overall objective and acceptance;
- decomposition and dependencies;
- confirmed decisions and important discoveries;
- completed slice commits and verification verdicts;
- current blockers and next slice.

Do not pull implementation transcripts into main unless they contain evidence needed for a decision. Prefer commit ids, concise verified summaries, and durable artifacts.

Use `skill://handoff` if the main conversation itself becomes long enough that a compact checkpoint is useful.

## Final acceptance

After all slices pass their local loops, inspect the combined result at task level. Run or delegate integration-level verification that can observe interactions between slices. Check the original request, not merely the list of completed stages.

Finish only when the whole requested outcome is satisfied or a specific unresolved blocker is reported with evidence.
