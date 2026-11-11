# Core read-only state contract (v1)

Normative, tracked contract for the two process-wide read-only Core sources:
the **subagents** source and the **task-workspace** source. It is the only
interface a foreign consumer (for example an inspection provider owned by
another product) may use; importing Core modules, reading Core files on disk,
probing tool names, or guessing from a package identity is not part of it.

The owners are the loaded Core extensions themselves:

| Source | Publisher | Data owner |
| --- | --- | --- |
| subagents | `extensions/subagents/read-only-state.ts` | the subagents runtime of this process |
| task-workspace | `extensions/task-workspace/read-only-state.ts` | Core's session-scoped current-task computation |

The sources are **independent**: loading, failing, or unloading one never
disables the other. A consumer must be able to work with either one alone.

## Discovery

```
globalThis[Symbol.for("agentkit.read-only-state.v1")]
```

The symbol name carries the registry identity. The value is one registry
object shared by every module graph of the process (Pi evaluates each extension
entry through a fresh loader graph and re-evaluates them on `/reload`, so
module-level state would fork per graph; the registry is registered on
`globalThis`).

```ts
type Registry = {
  schemaVersion: 1;
  subagents?: SubagentsSource;      // absent while no subagents extension is loaded
  taskWorkspace?: TaskWorkspaceSource; // absent while no task-workspace extension is loaded
};
```

Schema `1` is:

```ts
type SubagentsSource = {
  version: 1;
  owner: unknown;                   // opaque; readers never inspect or compare it
  read(): SubagentsResult;
};

type TaskWorkspaceSource = {
  version: 1;
  owner: unknown;
  sessionGeneration(): number;
  read(): Promise<TaskWorkspaceResult>;
};
```

Nothing else is part of the contract: no transport state, no file descriptors,
no streams, no spawn/steer/cancel methods, no state setters. A consumer cannot
change Core state through this interface, and Core does not know any consumer.

## Reader algorithm (exact)

A reader resolves each source on its own, and repeats the resolution on every
poll (never caches a source object across polls):

1. Read `globalThis[Symbol.for("agentkit.read-only-state.v1")]`.
2. If it is not an object, or `schemaVersion !== 1`: **both sources are
   unavailable** (unknown — not empty, not an error inside the source).
3. For the subagents source: if `registry.subagents` is absent, not an object,
   `version !== 1`, or `read` is not a function → **unavailable**. Otherwise
   call `read()`.
4. For the task-workspace source: if `registry.taskWorkspace` is absent, not an
   object, `version !== 1`, `read` is not a function, or `sessionGeneration` is
   not a function → **unavailable**. Otherwise call `read()` and await it.
5. Do not reinterpret a source whose `version` is not exactly the version the
   reader supports. Versions are not negotiated, not ranged, and not probed
   by feature presence. An unsupported version is unavailable, never a
   best-effort read.

A reader that finds an incompatible `schemaVersion` must not rewrite the
registry, inject entries into it, or repair it. A consumer's write path into
Core state does not exist.

## Subagents source

```ts
type SubagentsResult =
  | { status: "ok"; activity: "active" | "idle"; agents: AgentObservation[] }
  | { status: "error"; error: { code: "snapshot_failed" | "invalid_snapshot"; message: string } };
```

- The source is published at extension registration and covers the live
  runtime of THIS process. A loaded source with no spawned children answers
  `status: "ok"`, `agents: []` — an empty result is a real observation, not a
  failure and not an unknown.
- A failing snapshot answers `status: "error"`. It never turns into an empty
  list, and it never throws to the consumer. The published `read` is
  synchronous.
- `activity` is Core's own classification of confirmed activity:
  `"active"` when at least one observation has `alive: true` **and** a
  non-terminal state (`starting`, `running`, `waiting_input` — the runtime's
  own running set in `extensions/subagents/running-state.ts`), otherwise
  `"idle"`. Process liveness alone is not activity: a child that settled into
  `completed`/`failed`/`cancelled` keeps a live process until idle exit and
  must not make the background look busy. There is no third value: when the source is unavailable, or the
  read failed, `activity` does not exist — the consumer must treat background
  activity as **unknown** and keep its ordinary idle policy. Unknown is never
  rendered as confirmed idle and never as a zero.
- On `session_shutdown` the owning extension withdraws its record; a consumer
  then observes the source as unavailable (see ownership rules).

### `AgentObservation` (one child)

The record is Core's existing `agentDetailView` projection, published as a
deeply detached snapshot so no observation the current Core surfaces are lost.
Mutating a returned array or any nested object cannot mutate Core or a later
read. Failure to clone a snapshot is `snapshot_failed`, not a partial result. Fields are
optional except `id`, `label`, `state`, `alive`; a field that Core cannot know
is absent (never `0`, `""` or `false` as a stand-in).

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Stable child identity inside this process/session. |
| `label` | `string` | Human/model-facing name. |
| `state` | `"starting" \| "running" \| "waiting_input" \| "completed" \| "failed" \| "cancelled"` | Logical lifecycle state. |
| `alive` | `boolean` | Process liveness at snapshot time (independent of `state`). |
| `task` | `string` | Child task prompt, clipped to 200 characters. |
| `cwd` | `string` | Child working directory. |
| `model`, `thinking` | `string` | Selected model and thinking level. |
| `pid` | `number` | Child OS pid while alive. |
| `startedAt`, `endedAt`, `lastActivityAt` | `number` | Epoch milliseconds. `endedAt` absent while running. |
| `elapsedMs` | `number` | Elapsed milliseconds at snapshot time. |
| `sessionFile` | `string` | Child transcript path — a hint only, see "Read authorization". |
| `sessionId` | `string` | Child session id. |
| `pendingQuestion` | `string` | Rendered question while `waiting_input`. |
| `lastError` | `string` | Failure text. |
| `signal` | `string \| null` | Terminating signal; null while unknown or not signalled. |
| `exitCode` | `number \| null` | Process exit code; `null` while unknown/running. |
| `stats` | `{ tokens: { input, output, total, cacheRead?, cacheWrite? }, cost?, contextUsage? }` | Child-only spend and context fill. Absent until the child reports once, so absent is unknown, not zero. |
| `activeTool` | `{ name, summary?, startedAt, endedAt? }` | Tool currently executing in the child. |
| `recentActivity` | `{ name, summary?, startedAt, endedAt? }[]` | Bounded newest-last finished tools. Telemetry, not a log. |
| `lastAssistantText` | `{ text, updatedAt }` | Bounded last public assistant text. Absent until the first accepted message. |
| `run` | `RunObservation` (below) | Compact workspace-run view, present only for run-owned (workspace) children. The bounded product result is at `run.terminal.result`, never `run.result`. |

Exact nested declarations (all token counts are numbers of tokens, not bytes):

```ts
type SessionStats = {
  tokens: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost?: number; // cumulative child-session cost in USD, not cents
  contextUsage?: {
    tokens?: number | null; // estimate; null immediately after compaction
    contextWindow?: number; // model context limit in tokens
    percent?: number | null; // percentage, 0..100 scale (not a fraction); null after compaction
  };
};
type ProductStatus = "done" | "partial" | "blocked";
type RunObservation = {
  workspace: string;
  state: "running" | "waiting_input" | "settling" | "terminating" | "settled";
  deadlineMsLeft: number; // remaining milliseconds, clamped to >= 0
  deadlineAt?: number; // epoch milliseconds
  progress?: {
    achieved: string;
    currentWork: string;
    blocker?: string; // absent if no blocker is known
    nextStep: string;
    updatedAt: number; // epoch milliseconds assigned by Core
  };
  progressAgeMs?: number; // non-negative milliseconds since progress.updatedAt
  status?: ProductStatus; // present for settled runs, same as terminal.status
  terminal?: {
    status: ProductStatus; // runtime outcome, can differ from product result
    reason?: string;
    result?: { status: ProductStatus; summary: string }; // bounded product report
  };
  ladder?: { step: number; max: number }; // retry step, 1..max; current max is 3
};
```

Progress strings are normalized (control characters removed, whitespace
collapsed) and bounded to 1000 characters per input field. Unknown progress is
absent. `terminal` is absent before settlement; `terminal.result` is absent
when no valid report exists. No full report, verification array, Git facts or
question payload is exposed by the compact run projection. `ladder` describes
report-recovery attempts, not a child lifecycle or product status.

`stats` never includes the parent session, and the source never sums children
into a total. A consumer that displays a total sums the per-child rows itself
and must not add them to parent usage twice.

## Task-workspace source

```ts
type TaskWorkspaceResult =
  | { status: "ok"; generation: number; projection: CurrentTaskProjection }
  | { status: "unavailable"; reason: "no_session" | "session_changed" }
  | { status: "error"; error: { code: "projection_failed"; message: string } };
```

- The source returns the **computed projection**, not a marker: workspace
  selection, history interpretation, and every Git read stay inside Core. A
  consumer must not recompute selection from the global task catalog, branch
  names, mtimes, or its own Git calls.
- `status: "unavailable"` with `reason: "no_session"` means this process has no
  live session bound: before the first `session_start`, or after
  `session_shutdown`. It is not "no task".
- `status: "unavailable"` with `reason: "session_changed"` means the session was
  switched, reloaded or shut down while this projection was being computed. The
  source rejects that completion itself (including a projection that rejects
  after the session changes), so a stale answer never carries a
  projection that a consumer could mistake for current.
- `status: "ok"` carries the projection; "no association" is
  `projection.state: "none"`, an association whose workspace vanished is
  `"missing"` (identity retained, `repos: []`), and a live association is
  `"ok"`.
- `status: "error"` covers an unexpected projection failure. Per-repository Git
  failures are NOT an error result: they surface inside the projection as
  `gitAvailable: false` and `dirty.available: false`, where empty lists mean
  unknown, never "clean".

### `CurrentTaskProjection`

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | `"none" \| "ok" \| "missing"` | Association state for this session. |
| `identity` | `string \| null` | Canonical task identity (workspace directory identity). |
| `workspace` | `string \| null` | Workspace path under the task root. |
| `source` | `"cwd" \| "session" \| null` | Selected by the managed session cwd, or by the latest successful `ensure_task_repo` on the current session branch. |
| `repos` | `TaskRepo[]` | Repositories of the selected workspace; empty unless `state: "ok"`. |

`TaskRepo` fields: `name`, `path`, `kind` (`"canonical" \| "lane"`), `slot`
(`string \| null`), `classification` (always `"MANAGED_TASK_WORKTREE"`),
`branch`, `detached`, `headSha` (`string \| null`), `upstream`
(`string \| null`), `gitAvailable`, `dirty` (`{ staged, unstaged, available }`),
`owners`.

`repos[].owners` is the only cross-source field: it lists active workspace
RepoOwners observed through the **subagents** source (`{ id, label, state }`);
settled and history children are never included. When the subagents source is
unavailable or failing, the list is empty and owner knowledge is **unknown** —
a consumer that needs to distinguish "no owner" from "cannot observe owners"
must read the subagents source itself. The task source never fails because of
the subagents source.

### Session generation

The generation counter lives in the shared registry, so it is **process-wide**
and shared by every loader graph: a reloaded graph and an older graph that is
still finishing a read can never mint the same number. It increases on every
session bind and on the current owner's session end (clear/shutdown), never decreases and
never resets; 0 means this process never bound a session. `read()` captures the
binding and the generation at read start, the result carries that
`generation`, and `sessionGeneration()` reports the process-wide current value.

Staleness is enforced by the source, not delegated to the consumer: a read that
finishes after the binding or the generation changed answers
`unavailable`/`session_changed` instead of a projection.

Consumer rules (both are required, and the second one covers a source object
that was replaced while the read was in flight):

- discard a `session_changed` answer and any answer whose `generation` is not
  the `sessionGeneration()` of the record you just resolved;
- re-resolve the registry slot after the read resolves and require it to be the
  same record object (`registry.taskWorkspace === record`) before presenting
  the result: a reloaded graph publishing a new record makes every result of
  the previous record stale, even when no session was bound in between;
- never carry a projection, workspace path, or child list across a session
  switch: a new session means a new binding, new generation, and a fresh read.

## Ownership, reload, and shutdown

This is the registration-ownership rule both sources implement:

1. Registration happens on every extension factory execution, so `/reload`
   and a new process graph publish a **new record** and take over the slot.
2. A record carries an opaque owner token identifying the publishing module
   copy. A reader never compares it.
3. `session_shutdown` withdraws the record **only if the current record is this
   graph's own**. A stale graph's shutdown therefore cannot delete the source
   published by a newer graph, and a stale graph cannot resurrect a withdrawn
   record by publishing after its own shutdown.
4. A stale graph may clear its own binding but cannot advance the shared
   generation: its shutdown cannot invalidate an in-flight read of the new
   owner. Successful and failed projections both check staleness before
   returning their outcome.
5. After withdrawal the source is unavailable; a consumer treats it as unknown
   and keeps its own lifecycle policy. It must not read the old projection
   again, cache it, or reconstruct it.

A reloaded source replaces the previous one atomically from the consumer's
point of view: the registry slot is overwritten in one assignment, so a reader
sees either the old record or the new one, never a half-built mix.

## Claude CLI task source (read-only)

Hosts that have no Pi extension (Claude Code) reach the same projection through
the explicitly configured public CLI. It is a second binding of the same
`current.ts` computation, not a second implementation:

```
agent-kit task current '{"cwd":"<abs>","selections":[{"task":"…","worktree":"…"}]}'
```

The parameters are the caller's verified session facts: `cwd` is a parameter,
not the process cwd, and `selections` are the session's successful
`ensure_task_repo` tasks in order (last wins). The CLI never invents a session,
never reads another session's history, and performs no owner matching.

```json
{ "version": 1, "state": "none|ok|missing", "identity": "…|null",
  "workspace": "…|null", "source": "cwd|session|null", "repos": [ … ] }
```

- `version` identifies the answer and is checked exactly by the consumer. It is
  additive: every projection field keeps the meaning documented above, so a
  reader that predates the field is unaffected. A changed meaning bumps the
  version; do not negotiate, do not guess from field presence.
- One JSON object on stdout, always. Exit codes: `0` — the projection was
  computed (including `state: "none"` and `state: "missing"`); `1` — tool error,
  the object is `{"status":"error","message":…}`; `2` — usage error (missing or
  malformed parameters), the object is `{"status":"usage_error",…}`.
- CLI absence, a non-zero exit, an incompatible `version`, or unparseable
  output make **only this projection** unavailable. They are not a session
  failure, do not justify restarting the harness, and must not become a
  permanent per-poll shell call of a missing binary: probe once per runtime,
  diagnose once, and keep the rest of the panel working.
- The mutation commands (`ensure`, `remove-lane`, `teardown`, `commit`) and the
  `hook` subcommand are explicitly **not** part of this read-only contract and
  are unchanged by it.

## Read authorization

The contract does not widen any read permission. A consumer that wants to read
a file named by `sessionFile` (or any path inside a projection) must apply its
own authorization: runtime/session identity, realpath resolution, containment
in allowed roots, and re-verification immediately before opening. Core makes
no statement that `sessionFile` exists right now; the path is a hint produced
by the child runtime.

## Versioning rules

- `version` is exact. Any incompatible change of a source's shape or meaning
  publishes a new source version, and readers of the old version see the
  source as unavailable.
- A change to the registry shape publishes under a new symbol
  (`agentkit.read-only-state.v2`), never reinterprets `v1`.
- Adding an optional field that does not change the meaning of existing fields
  is compatible and does not bump the version; consumers must ignore unknown
  fields. Removing or redefining an existing field, changing a unit, or
  changing a state's meaning is incompatible.
- `unknown`/`null`/absent never silently become `0`, `[]`, `false`, or
  `"idle"`. Source absence, an empty source result, and a source error are
  three distinct observations and stay distinct end to end.

## Contract tests

| Guarantee | Test |
| --- | --- |
| Both copies (subagents, task-workspace) publish into one shared registry and agree on symbol/versions; discovery needs no Core import | `extensions/subagents/read-only-state-contract.test.ts` |
| Actual Pi entry loader, forced-transform jiti graphs, gated stale reads, stale shutdown, real isolated Pi RPC command-driven reload with zero model turns | `extensions/subagents/read-only-state-loader.test.ts` |
| Publisher: empty vs rich observations, detached nested values, exact compact run shape, activity classification, error vs empty, ownership on reload/shutdown, version gating | `extensions/subagents/read-only-state.test.ts` |
| Task source: publish/bind/generation, `unavailable` vs `none`, injected projection failure, source-rejected stale completion, cross-graph generation uniqueness, owner-enrichment through the subagents slot | `extensions/task-workspace/read-only-state.test.ts` |
| CLI binding: exact `version` on every read-only answer, unchanged projection fields and usage/error contract | `extensions/task-workspace/cli.test.ts` |
