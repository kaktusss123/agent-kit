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

For an existing task repository, the canonical worktree is the default
continuation target. Create a secondary lane only for an explicit additional
branch need in the user request or SPEC (such as a backport/forward-port or a
coexisting release/hotfix branch), never merely for testing, deployment,
commit isolation, or a clean checkout.

Treat base provenance as part of task judgment: pass `base_ref` only when the
user, SPEC/task decision, or an unambiguous earlier continuation fixed it.
Seeing a branch or SHA in Git output is not enough. A blocked routing operation
must be resumed in the managed worktree, not reproduced through another
mutation surface.

Keep commit, push, deployment, and acceptance distinct. Before an external side
effect, check the SPEC gates tied to that side effect; an ordinary draft-MR push
does not inherit unrelated deployment acceptance gates. Do not call a side
effect ready while its specific blocker remains open.

Multi-repo work: act as the task-level orchestrator. When multi-repo scope is known before meaningful mutation, every writable repository gets its own repo owner — keep none of them for yourself. Spawn each owner with the `workspace_agent` tool, passing `workspace` = the absolute managed worktree path returned by `ensure_task_repo`; the owner session is rooted in that worktree, works with relative paths, sees the repository's own project instructions, and finishes with a structured yield envelope. Run independent owners as parallel tool calls. After dispatch there is never an automatic fallback — a failed owner returns `partial` or `blocked` with `child_may_have_mutated_repo`; inspect the worktree and repair with a fresh `workspace_agent` invocation that first inspects existing state. Let each worker own its repository, verify locally, and yield the compact structured verification report (see `skill://git-task`), then run the cross-repo integration verification yourself. When a second repository appears mid-implementation, keep ownership of the repo you already started and spawn an owner only for the newcomer; update the specification first if the cross-repo contract changes.

Host-specific owner mechanics (do not mix these into a shared contract):

- **Pi (subagents workspace layer):** the owner profile has no nested delegation — repo-local helpers are part of the owner's own work, never `subagent`/`task` calls. When `workspace_agent` is absent on this install, or a dispatch returns `unsupported` with `dispatched=false` (missing profile entrypoints, refused readiness, extension load failure), degrade to the documented fallback: `subagent op=spawn` with `cwd` = the absolute managed-worktree path, the task in the prompt, owner addressing its repository by absolute paths only — and ask the child for the structured report below (without the workspace layer it is advisory, not enforced). Terminal owners are retired; repair means a NEW owner that first inspects existing state.
- **OMP:** the owner may delegate repo-local helpers via the stock `task` tool — those helpers inherit the same worktree. When `workspace_agent` is unavailable or returns `unsupported`/`dispatched=false`, fall back to a stock `task` owner with the absolute managed-worktree path in the prompt. Retained-owner revival semantics remain OMP-specific.

RepoOwner run protocol (Pi, subagents workspace layer):

- The dispatch call blocks until `done`, `partial`, `blocked`, or `needs_input`. `needs_input` suspends the owner without finishing the run — answer it with `subagent op=respond` (allowed on RepoOwners); the run resumes under the same deadline. Never re-dispatch to "answer" a question.
- External `status` is the outcome of the workspace_agent protocol; the owner's product outcome is `result.status`, present only when external status is `done`. Query-mode reports an in-progress run as `running` — never treat `partial`/`blocked` as "still working": they mean inspect and repair. Read the envelope, not just the outer status.
- A terminal run is announced as a `[workspace_agent completed]` message with the full envelope. That notification is not the only API: if it was lost (rare `sendMessage` rejection, compaction race), `workspace_agent(run_id)` returns the same terminal envelope for the rest of the session.
- The `subagent` tool on a RepoOwner accepts only `status`, `result`, `respond`, `cancel`. `wait`, `steer`, `follow_up` are rejected with an explanation: the owner's lifecycle events belong to the workspace registry, and steering would bypass the run's deadline and task contract.
- After a terminal outcome the owner process is retired (no `ps` hit, no follow-ups); its record keeps the original terminal status. Repair means a NEW owner that first inspects existing state.
- Envelope schema — keep literally identical to the reporting bridge (`extensions/subagents/envelope-schema.ts` in pi-tuning) and to the worker report in `skill://git-task`:

```json
{
  "status": "done | partial | blocked",
  "summary": "string",
  "changed_scope": ["string"],
  "verification": [{ "check": "string", "cwd": "string?", "result": "pass | fail | blocked" }],
  "gaps": ["string"],
  "contract_conflicts": ["string"]
}
```

Required: status, summary, changed_scope, verification, gaps. Optional: contract_conflicts. No additional properties.

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
