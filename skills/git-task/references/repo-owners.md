# Repository owners (Pi)

Deterministic contract of the `workspace_agent` tool (subagents extension, workspace layer) and its interaction with the generic `subagent` tool. The workspace layer provides readiness validation, deadlines, and the structured terminal envelope; the model never simulates them.

## Dispatching an owner

`workspace_agent(workspace, task, timeout_ms?)` runs a RepoOwner: an independent agent process rooted in a managed task worktree.

- `workspace` — the absolute managed worktree path from `ensure_task_repo`; the owner works with relative paths there and sees the repository's own project instructions.
- `task` — the complete owner assignment: intent, applicable contract artifacts (e.g. SPEC.md), the worker report contract from SKILL.md, and the instruction to change only this repository.
- The call blocks until a terminal outcome (`done`, `partial`, `blocked`) or `needs_input`.

Dispatch is strict and fail closed: a subagents-owned readiness probe (the last profile entry in the child) confirms initialization from the child's actual session tool set before the task prompt reaches a model; any refusal kills the child with `dispatched: false` and the task is never sent. After the prompt is accepted there is no automatic fallback — an abort detaches and the run keeps going; repair is a fresh dispatch.

`workspace_agent` is the only owner dispatch. If the tool is absent, returns `unsupported`, or fails readiness (`dispatched: false`), report the task blocked/unsupported. Do not substitute a generic `subagent` spawn: without the workspace layer there is no readiness validation, no enforced deadline, and no terminal envelope.

## During a run

- `needs_input` suspends the owner without finishing the run: the owner asked a decision it cannot resolve. Resolve it from Main's own conversation and task context first; only escalate an unknown decision to the user via Main's `ask`. Answer with `subagent` op `respond` (allowed on RepoOwners); the same run resumes under the same deadline. Never re-dispatch to "fix" a pending question.
- Query mode `workspace_agent(run_id)` returns the current state (`running`, `needs_input`) or the terminal envelope of any run of this session, anytime. The completion notification is not the only API.

## Terminal outcomes

A terminal run is announced as a completion message; the envelope is also available via query mode for the rest of the session.

- `done` — the envelope carries the owner's product outcome in `result.status` plus its structured report (summary, verification, gaps, conflicts per SKILL.md). For a `done` product outcome the runtime additionally verifies the settled worktree after the child stopped: accessible git repository, current HEAD, clean tree (untracked non-ignored files count as dirt; ignored build output does not). A failed check downgrades the outcome to `blocked` with a `done_rejected_*` reason and no trusted `result`.
- `partial` — deadline hit mid-run; carries `child_may_have_mutated_repo`. Inspect the worktree state before any repair decision.
- `blocked` — refusal, failed readiness, the report-recovery ladder exhausted, or a rejected `done` from the settled-state check above; carries the reason. The child may still have mutated the repo.

Every terminal outcome carries `git_facts` (branch, HEAD SHA, dirty paths) read mechanically by the runtime from the worktree after the child stopped — never ask the model which commit it produced or whether anything is left uncommitted; read `git_facts`.

A terminal outcome retires the owner: the process is settled and its record keeps the original terminal status forever. Terminal states never re-enter work.

## Repair

Repair means a NEW `workspace_agent` dispatch whose task begins with inspecting the existing worktree state (a previous owner may have partially mutated it). Never repair by editing another owner's repository directly and never by steering the settled owner — the tool rejects it.

## Restrictions the runtime enforces

- RepoOwner children cannot nest delegation: repo-local helpers are part of the owner's own work, never `subagent`/`task` calls from the owner.
- On an owner, the `subagent` tool accepts only `status`, `result`, `respond`, `cancel`; `wait`, `steer`, `follow_up` are rejected (owner lifecycle events belong to the workspace registry; steering would bypass the deadline).
- Workspace runs produce no generic `[subagent ...]` deliveries; do not `wait()` on them.

Generic (non-owner) subagents spawned with `subagent` op `spawn` keep the full op set — that path is outside the workspace layer and out of scope for this reference.
