# Repository owners (Pi)

Deterministic contract of workspace-mode `subagent` spawns (subagents extension, workspace run layer). There is one child-agent surface: `subagent`. A spawn that passes `workspace` becomes the owner (RepoOwner) of that managed worktree and gains readiness validation, an enforced deadline, and the structured terminal envelope; the model never simulates them.

## Dispatching an owner

`subagent op=spawn workspace=<worktree> task=<assignment> deadlineSec=<seconds>` runs a RepoOwner: an independent agent process rooted in a managed task worktree. The child inherits the main session model; `modelClass` does not apply to workspace spawns (plain `cwd` spawns keep it).

- `workspace` — the absolute managed worktree path from `ensure_task_repo`; the owner works with relative paths there and sees the repository's own project instructions.
- `task` — the complete owner assignment: intent, applicable contract artifacts (e.g. SPEC.md), the worker report contract from SKILL.md, and the instruction to change only this repository. The registry retains this canonical text unchanged.
- `deadlineSec` — the hard runtime deadline. The runtime appends a budget block only to the dispatched child prompt. It states the deadline and a finalization reserve equal to 20% of the duration, with a 30-second minimum, and tells the owner to stop new scope at that boundary, commit coherent work, run only checks that fit, and report `partial` instead of being killed mid-change.
- The call blocks until a terminal outcome (`done`, `partial`, `blocked`) or `needs_input`.

Dispatch is strict and fail closed: a subagents-owned readiness probe (the last profile entry in the child) confirms initialization from the child's actual session tool set before the task prompt reaches a model; any refusal kills the child with `dispatched: false` and the task is never sent. After the prompt is accepted there is no automatic fallback — an abort detaches and the run keeps going; repair is a fresh dispatch.

A workspace spawn is the only owner dispatch. If it returns `unsupported`, fails readiness, or is refused (`dispatched: false`), report the task blocked/unsupported. Do not substitute a plain `cwd` spawn: without the workspace mode there is no readiness validation, no enforced deadline, and no terminal envelope.

## During a run

- `needs_input` suspends the owner without finishing the run: the owner asked a decision it cannot resolve. Resolve it from Main's own conversation and task context first; only escalate an unknown decision to the user via Main's `ask`. Answer with `subagent` op `respond` (allowed on RepoOwners); the same run resumes under the same deadline. Never re-dispatch to "fix" a pending question.
- `subagent` op `status` shows the run state (`running`, `waiting_input`, settling/terminating) with deadline left; op `result` returns the current or terminal outcome (envelope + `git_facts`) of any run of this session, anytime. The completion notification is not the only API.

## Terminal outcomes

A terminal run is announced as a completion message; the terminal outcome (envelope + `git_facts`) stays reachable via `subagent` op `result` for the rest of the session.

- `done` — the envelope carries the owner's product outcome in `result.status` plus its structured report (summary, verification, gaps, conflicts per SKILL.md). For a `done` product outcome the runtime additionally verifies the settled worktree after the child stopped: accessible git repository, current HEAD, clean tree (untracked non-ignored files count as dirt; ignored build output does not). A failed check downgrades the outcome to `blocked` with a `done_rejected_*` reason and no trusted `result`.
- `partial` — deadline hit mid-run; carries `child_may_have_mutated_repo`. Inspect the worktree state before any repair decision.
- `blocked` — refusal, failed readiness, the report-recovery ladder exhausted, or a rejected `done` from the settled-state check above; carries the reason. The child may still have mutated the repo.

Every terminal outcome carries `git_facts` (branch, HEAD SHA, dirty paths) read mechanically by the runtime from the worktree after the child stopped — never ask the model which commit it produced or whether anything is left uncommitted; read `git_facts`.

A terminal outcome retires the owner: the process is settled and its record keeps the original terminal status forever. Terminal states never re-enter work.

## Repair

Repair means a NEW workspace spawn whose task begins with inspecting the existing worktree state (a previous owner may have partially mutated it). Never repair by editing another owner's repository directly and never by steering the settled owner — the tool rejects it.

## Restrictions the runtime enforces

- RepoOwner children may spawn repo-local helpers through the same `subagent` tool: plain `cwd` spawns only, with the full `modelClass` choice (cheap/default/smart). Helpers are part of the owner's execution and may use ordinary tools inside this workspace, but they cannot create workspace spawns: a managed worktree has exactly one owning RepoOwner, and helpers never become separate RepoOwners.
- On an owner, the `subagent` tool accepts only `status`, `result`, `respond`, `cancel`; `wait`, `steer`, `follow_up` are rejected (owner lifecycle events belong to the workspace registry; steering would bypass the deadline).
- Workspace runs produce no generic `[subagent ...]` deliveries; do not `wait()` on them.

Generic (non-owner) `cwd` spawns keep the full op set — that path is outside the workspace mode and out of scope for this reference.
