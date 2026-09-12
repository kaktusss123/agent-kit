Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in `task`.

After each successful state-changing op: if nothing is `in_progress`, the earliest `pending` task (phase order) auto-promotes to `in_progress`; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move pointer back to an earlier phase—expected.

Terminal states are enforced: `completed` and `abandoned` tasks NEVER re-enter work through `start`/`done`/`drop`; repeating a settle on an already-settled task is a no-op; `blocked` returns to work only via `unblock`. Phase-wide `done`/`drop` settle open tasks and skip already-settled ones.

## Operations

|`op`|Fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list; replaces existing|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress; `pending` tasks only (repeat on `in_progress` is a no-op; `completed`/`abandoned`/`blocked` are rejected)|
|`done`|`task` or `phase`|Mark completed; already-settled tasks are no-op/skipped, never flipped|
|`drop`|`task` or `phase`|Mark abandoned; already-settled tasks are no-op/skipped, never flipped|
|`block`|`task` or `phase`; optional `reason`|Mark blocked: awaiting external input; never auto-promotes; excluded from stop-time incomplete-todo reminder|
|`unblock`|`task` or `phase`|Blocked task → `pending`|
|`rm`|optional `task` or `phase`|Remove task/phase; omit both → clear|
|`append`|`phase`; `items: string[]`|Append tasks to phase; lazily creates phase|
|`view`|—|Read-only; echo list|

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules

- Mark tasks done immediately after finishing; complete phases in order.
- NEVER make a todo call the turn's only tool call. Batch with real work: `init` with first reads/edits; each `done`/`start` with next action. Solo todo turns waste a round trip.
- Waiting on something you can't act on—a user decision, another agent, external service: `block` task (optional `reason`); remains tracked but avoids stop reminder. `unblock` when actionable. If the blocker is agent-actionable, `append` an unblocking task instead.
- Keep introduced `task`/`phase` strings stable.
- Lost exact task text: `view` echoes list; NEVER guess from memory.
- If the user asks to adjust the list (add/remove/reword/reorder), apply it with `append`/`rm`/`init` immediately.

## Create a list

- Task requires 3+ distinct steps.
- User explicitly requests one.
- User provides a set of tasks.
- New instructions arrive mid-task: capture before proceeding.

<critical>
User gives multi-step plan—phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- MUST `init` every item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
