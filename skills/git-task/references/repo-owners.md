# Repository owners (Pi)

Deterministic contract of workspace-mode `subagent` spawns (subagents extension, workspace run layer). There is one child-agent surface: `subagent`. A spawn that passes `workspace` becomes the owner (RepoOwner) of that managed worktree and gains readiness validation, an enforced deadline, and the structured terminal envelope; the model never simulates them.

## Dispatching an owner

`subagent op=spawn workspace=<worktree> task=<assignment> deadlineSec=<seconds>` runs a RepoOwner: an independent agent process rooted in a managed task worktree. The child's model: an explicit `model` (`provider/id[:thinking]`) always wins; omitted, the `owner` role binding (`/subagent-role owner ...` — the user's explicit choice), else the current session model decides. Workspace spawns always run as role `owner`; `role` and `model` are mutually exclusive, and resolution fails closed before dispatch when a named model or the binding cannot be resolved. Do not pass `model` or `role` on owner dispatches unless the user asked for a specific model — do not override the binding merely because the work looks complex.

- `workspace` — the absolute managed worktree path from `ensure_task_repo`; the owner works with relative paths there and sees the repository's own project instructions.
- `task` — the complete owner assignment: intent, applicable contract artifacts (e.g. SPEC.md), the worker report contract from SKILL.md, and the instruction to change only this repository. The registry retains this canonical text unchanged.
- `deadlineSec` — the hard runtime deadline. The runtime appends a budget block only to the dispatched child prompt. It states the deadline and a finalization reserve equal to 20% of the duration, raised to at least 30 seconds when possible and capped by the hard deadline. It tells the owner to stop new scope at that boundary, commit coherent work, run only checks that fit, and report `partial` instead of being killed mid-change.
- `waitTimeoutSec` — maximum continuous Main wait (default 600 seconds), independent of `deadlineSec`. The call returns a terminal outcome (`done`, `partial`, `blocked`), `needs_input`, or `running` on wait expiry. A `running` return does not stop the child, release ownership, or extend the deadline; use `subagent op=wait id=<agentId> timeoutSec=<seconds>` to continue waiting on the SAME run. Completion still arrives through the existing notification.

Dispatch is strict and fail closed: a subagents-owned readiness probe (the last profile entry in the child) confirms initialization from the child's actual session tool set before the task prompt reaches a model; any refusal kills the child with `dispatched: false` and the task is never sent. After the prompt is accepted there is no automatic fallback — an abort detaches and the run keeps going; repair is a fresh dispatch.

A workspace spawn is the only owner dispatch. If it returns `unsupported`, fails readiness, or is refused (`dispatched: false`), report the task blocked/unsupported. Do not substitute a plain `cwd` spawn: without the workspace mode there is no readiness validation, no enforced deadline, and no terminal envelope.

## During a run

- `needs_input` suspends the owner without finishing the run: the owner asked a decision it cannot resolve. Resolve it from Main's own conversation and task context first; only escalate an unknown decision to the user via Main's `ask`. Answer with `subagent` op `respond` (allowed on RepoOwners); the same run resumes under the same deadline. Never re-dispatch to "fix" a pending question.
- `report_progress` records achieved results, current work, an optional agent-reported blocker, and the next step (maximum 1000 characters per text). It replaces the previous progress with a runtime timestamp, is not approval, and never substitutes for the final `report_result` or changes its last-action requirements.
- `subagent` op `status` / `result` expose the last progress separately from observed tool activity and the remaining deadline, including after termination. `deadlineAt` is absolute Unix milliseconds; `progressAgeMs` is computed at read time. Missing progress means not reported, not a guessed blocker or proof of thinking.
- `subagent op=steer` queues a request through Pi's safe steering RPC between actions, without aborting a tool or changing the deadline. Settling, terminating and settled owners reject steering. `follow_up` remains forbidden; it cannot restart an owner.

## Terminal outcomes

A terminal run is announced as a completion message; the terminal outcome (envelope + `git_facts`) stays reachable via `subagent` op `result` for the rest of the session.

- `done` — the envelope carries the owner's product outcome in `result.status` plus its structured report (per the worker report contract below). For a `done` product outcome the runtime additionally verifies the settled worktree after the child stopped: accessible git repository, current HEAD, clean tree (untracked non-ignored files count as dirt; ignored build output does not). A failed check downgrades the outcome to `blocked` with a `done_rejected_*` reason and no trusted `result`.
- `partial` — deadline hit mid-run; carries `child_may_have_mutated_repo`. Inspect the worktree state before any repair decision.
- `blocked` — refusal, failed readiness, the report-recovery ladder exhausted, or a rejected `done` from the settled-state check above; carries the reason. The child may still have mutated the repo.

Every terminal outcome carries `git_facts` (branch, HEAD SHA, dirty paths) read mechanically by the runtime from the worktree after the child stopped — never ask the model which commit it produced or whether anything is left uncommitted; read `git_facts`.

A terminal outcome retires the owner: the process is settled and its record keeps the original terminal status forever. Terminal states never re-enter work.

## Worker report contract

Before `report_result(status=done)`, the finished state must be committed as a candidate commit, and the final verification must have run against the repository after that commit was created (ADR-0002). Checks run before the commit remain development feedback; they do not replace the post-commit final verification. If verification, hooks, or repair changed repository state after the last commit, that state is a new candidate: commit it and verify it again before yielding.

The report itself is compact JSON, no raw test output:

```json
{
  "status": "done | partial | blocked",
  "summary": "one paragraph",
  "changed_scope": ["paths or areas"],
  "verification": [
    { "check": "<project verification command>", "cwd": "<worktree>", "result": "pass | fail | blocked" }
  ],
  "gaps": ["what was not run or could not run, and why"],
  "contract_conflicts": ["disagreements with SPEC.md, if any"]
}
```

Main reads this report as the owner's claim about the settled state and re-runs checks only when the report is missing or incomplete, repository state changed after the check, a result looks suspicious, or the check belongs to integration acceptance.

## Repair

Repair means a NEW workspace spawn whose task begins with inspecting the existing worktree state (a previous owner may have partially mutated it). Never repair by editing another owner's repository directly and never by steering the settled owner — the tool rejects it.

## Restrictions the runtime enforces

- RepoOwner children may spawn repo-local helpers through the same `subagent` tool: plain `cwd` spawns only, with the full `model` / `role` choice (`explore`, `helper`, `review`). Helpers are part of the owner's execution and may use ordinary tools inside this workspace, but they cannot create workspace spawns: a managed worktree has exactly one owning RepoOwner, and helpers never become separate RepoOwners.
- Main may use `status`, `result`, `respond`, `cancel`, workspace `wait`, and safe `steer`; only `follow_up` is rejected. Workspace wait uses the workspace registry, never the generic controller waiter that consumes lifecycle events.
- A canonical worktree is reserved before dispatch and remains owned until actual child stop and completion of runtime Git reads. Concurrent duplicate spawns (including canonical path aliases) are refused. No incomplete terminal outcome is exposed while Git facts are being read; one completion notification is sent.
- Last progress is preserved in terminal outcomes and optional persisted history (see `extensions/subagents/README.md`, ZAVOD-39 consumer contract). History never means a live run can be reattached after Main restarts.

Generic (non-owner) `cwd` spawns keep the full op set — that path is outside the workspace mode and out of scope for this reference.
