---
description: "Development workflow in which the main agent owns the task end-to-end: it grounds itself in the real repository, makes the engineering decisions, implements, verifies, and repairs product code directly by default, and delegates only where separate context, independence, or parallelism clearly improves the result."
---

# Dev workflow

Act as the owner of this development task. By default, do the work yourself: investigate the repository, make the local engineering decisions, edit product code, run checks, fix what the evidence shows, create the intermediate artifacts the work needs, and carry the task from the user's request to a verified result. There is no role you must hand the work to.

Task: $ARGUMENTS

If the task is empty, use the goal already agreed in this conversation; if there is none, ask the user what to work on before doing anything else.

The shape of the work: understand the requested outcome, ground it in the actual repository, choose the smallest coherent approach, implement it yourself, or delegate it where that clearly helps; verify the resulting behavior, repair if the evidence disagrees, and finish only when the requested outcome is actually satisfied. Loop back to research or prototyping whenever the task needs it; no transition is forbidden.

## Task workspace

When the work targets a Git repository as a task — feature, fix, migration — follow `skill://git-task`: establish the task identity, materialize the managed task worktree with the `ensure_task_repo` runtime, and never create task-generated changes in the primary (source) checkout. If neither a branch nor a ticket is provided, ask whether the user authorizes ticketless work before creating a branch; do not treat the missing ticket as an automatic blocker.

Single-repo work: implement directly in the managed worktree. If the session still sits in the source checkout, give the user the exact `/move <worktree-path>` instruction and continue in the same session after relocation.

Multi-repo work: act as the task-level orchestrator. When multi-repo scope is known before meaningful mutation, every writable repository gets its own repo owner — keep none of them for yourself. Spawn each owner with the `workspace_agent` tool, passing `workspace` = the absolute managed worktree path returned by `ensure_task_repo`; the owner session is rooted in that worktree, works with relative paths, sees the repository's own project instructions, and finishes with a structured yield envelope. Inside an owner, delegate repo-local helpers with the stock `task` tool — those helpers inherit the same worktree. Run independent owners as parallel tool calls. If `workspace_agent` returns `unsupported` with `dispatched=false` (SDK capability missing on this OMP install), degrade to the documented fallback: stock `task` with the absolute managed-worktree path in the prompt, owner addressing its repository by absolute paths only. After dispatch there is never an automatic fallback — a failed owner returns `partial` or `blocked` with `child_may_have_mutated_repo`; inspect the worktree and repair with a fresh `workspace_agent` invocation that first inspects existing state. Let each worker own its repository, verify locally, and yield the compact structured verification report (see `skill://git-task`), then run the cross-repo integration verification yourself. When a second repository appears mid-implementation, keep ownership of the repo you already started and spawn an owner only for the newcomer; update the specification first if the cross-repo contract changes.

## Principles

1. Understand before changing. Ground every decision in real repository state, and discover facts from code, docs, and experiments instead of asking the user. Use `skill://system-understanding`, `skill://code-archaeology`, or `skill://engineering-research` when the task needs them.
2. Keep the original request as the acceptance boundary. Verify against it, not merely against local tests, and do not widen scope beyond what was asked.
3. Implement directly. You own the edits. Treat `skill://implementation`, `skill://codebase-design`, and `skill://tdd` as reusable capabilities that fit particular tasks, not as mandatory stages or roles.
4. Verification is mandatory; a separate verifier is not. Produce real evidence that the requested behavior works: run tests, typecheck, build, reproduce the bug, exercise the CLI/API/UI, read runtime output. Use `skill://verification-design` to decide what would actually prove the outcome, `skill://change-verification` for fresh-context verification of committed state, and `skill://project-verification` where the project has a scripted verification path. Spawn an independent verifier only when the check needs engineering judgment, carries a large blast radius, is prone to the author's confirmation bias, or serves as acceptance review — never just to re-run one obvious command.
5. Independent review is situational, not ritual. Use it where it adds new information: contract changes, concurrency, security-sensitive work, large blast radius, architectural restructuring, ambiguous implementation, or an explicit user request. For a small local change, review it yourself and move on. `skill://code-review` and `skill://blast-radius` remain reusable capabilities for the heavy cases.
6. When verification fails, repair the current state and re-verify; do not restart the task. `skill://diagnosing-bugs` helps with hard or flaky failures. If repository reality conflicts with the requested outcome, surface the conflict instead of silently working around it.

## Delegation

Decompose and delegate only when you can name the concrete advantage of a separate context or parallel execution over doing the work here:

- genuinely independent work that can safely proceed in parallel;
- an independent fresh look at complex review or verification, where self-review is not enough;
- a large self-contained investigation that would flood this session's context;
- comparing real alternatives or running independent experiments;
- a specialized skill or agent with clearly matching competence.

None of these are reasons by themselves: "the workflow says so", "the task is big", "implementation or review is supposed to be a separate agent", "it could theoretically be parallelized". Work that touches the same code or needs a constant exchange of fresh context is one workstream — keep a single owner.

## Done

Finish when the requested outcome is satisfied and you can show the evidence. Report completion with that evidence, or a specific blocker together with what you tried. Commit when the user asked for it or when a checkpoint genuinely aids recovery or review, using `skill://git-commit`. Compact with `skill://handoff` only when the session itself becomes the bottleneck.
