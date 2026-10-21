# subagents

Native pi subagent runtime: each subagent is an independent `pi --mode rpc`
process with its own session, cwd, and lifecycle, owned by this extension in
the main process. No daemon, no shared hub.

## Surfaces

- **`subagent` tool** (LLM): one compact tool with ops
  `spawn / status / steer / follow_up / wait / result / respond / cancel`.
  Plain `spawn` (cwd) is asynchronous — it returns an id immediately and the
  child works in parallel; blocking on a child is `wait`, and the wait call
  renders live progress (state, current tool, bounded recent activity) into
  the tool call. Workspace `spawn` (`workspace=<managed worktree>`) is the
  RepoOwner mode: the call blocks until terminal, `needs_input`, or the
  independent continuous wait cap (`waitTimeoutSec`, default 600 seconds)
  with the same live progress, an enforced deadline, and the report-envelope
  contract (see the workspace section below). Management ops work uniformly
  for both modes.
- **Steering wake**: while a blocking call is in progress (a workspace spawn
  or a plain `wait`), any queued user message releases the call early so the
  agent loop reaches a turn boundary and Main stays responsive. A workspace
  spawn detaches (the run continues under its deadline; completion arrives
  via the background event); a plain `wait` returns a truthful `released`
  outcome while the child keeps running. The extension's own background
  deliveries never trigger the wake: every own `sendMessage` opens a short
  suppression window (see `steering-wake.ts`) that the pending-check
  consults.
- **Background delivery**: when a child reaches `completed`, `failed`, or
  `needs_input`, the main model receives a few compact lines via
  `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`. Pi 0.85.1
  delivers this at the next safe turn boundary when main is busy and starts a
  fresh run when main is idle (both verified against the installed version).
  Detached workspace runs deliver their completion through the same channel.
- **`/subagents` command**: compact live status table; `/subagents kill-all`
  terminates everything.
- **Tool card rendering** (`render.ts`): the `subagent` tool defines custom
  `renderCall`/`renderResult` for the transcript. The call renders as one
  line (`subagent <op>` plus workspace/label/task or agent id); results
  render as a compact card for workspace terminal outcomes (status glyph,
  `owner-<worktree>` with agent id, `branch @ sha`, tree cleanliness from
  runtime-read Git facts, envelope summary with a checks/scope metrics line;
  expanded view adds per-check results, scope, gaps, contract conflicts, and
  dirty paths). Rendering is display-only: `execute()` return values (content
  and details — the model-facing context) are never modified; errors,
  live wait snapshots, and plain management-op outputs pass through as
  sanitized text.

## Context discipline

The child transcript never enters main context. The model sees only the short
event message; the full final result, session location, timestamps, token
usage, and failure reason live in a persisted result file
(`$PI_CODING_AGENT_DIR/subagents/results/<id>.json`, default
`~/.pi/agent/subagents/results/`), fetched lazily via `subagent op=result`.
Each result also carries `parentSession` (the spawning main session file), so
a session's subagent spend survives a resume: the runtime sums results
attributed to the current session (resume base) plus live per-child stats and
emits the full total on the `subagents:cost` extension event; the footer
extension subscribes and renders the session's grand total.

## Escalation (`ask`)

Children run with a minimal bridge extension (`bridge.ts`) that registers one
tool: `ask` — the canonical model-facing question contract shared with main
(see `../ask/contract.ts`). There is no `ask_parent` anywhere in the model
surface; in every role the tool is just `ask`. The call blocks the child (only
the child) on the standard RPC extension UI protocol (`extension_ui_request`,
method `input`, title `ask`) carrying the structured request losslessly as the
payload. The controller surfaces it to main as a structured `needs_input`
(original ids, options, descriptions, previews, multi, recommended); main
first resolves from its own context and only escalates an unknown decision to
the user (via its own `ask`), then answers via `subagent op=respond` — a
plain-text answer resumes the same child tool call. There is deliberately no
answer timeout: an unresolved decision surfaces as a cancellation (runtime
cancel/deadline/shutdown), never as an instruction to guess.

## External controller read (`agentkit-status`)

One model-free, read-only command for an EXTERNAL RPC controller (no LLM turn,
no session writes, no runtime instantiation for an empty read):

- **Invocation**: RPC `prompt "/agentkit-status <area>"` with area
  `subagents | task | all` (default `all`). Executed immediately, even while
  main is streaming.
- **Wire transport**: the structured payload rides the standard extension UI
  input dialog with the wire title `agentkit:status` (same transport as the
  child `ask` dialog): `extension_ui_request {method:"input",
  title:"agentkit:status", placeholder:"<JSON payload>", timeout:15000}`.
- **Payload shape**: `{"v":1,"area":"<area>","data":{...}}` —
  `subagents` → `data:{agents:[agentDetail,...]}` (exactly the `subagent
  op=status` mapping via the shared `agentDetailView()` helper; empty list if
  the runtime was never started), `task` → `data:{task:<taskStatus result>}`
  (the `task_status` tool's structured result for the session cwd), `all` →
  both keys. Unknown area → `{"v":1,"area":...,"error":"..."}` over the same
  dialog path.
- **Controller answer**: `{id, "cancelled": true}` — there is nothing to
  answer; the dialog resolves and the read is done. The controller never
  forwards this dialog to a user.
- **Timeout semantics**: the dialog carries a finite `timeout: 15000` (ms).
  With no controller answer the dialog auto-dismisses and the read terminates
  with no side effects (fail closed) — it never hangs.
- **Non-RPC modes**: a brief `notify` pointing at `/subagents`; no blocking
  interactive workflow.

Live wire verification: `node live/status-verify.mjs` (real `pi --mode rpc`
with this worktree loaded explicitly; discovery, model-free reads, live
plain/workspace child state, `op=status` cross-check, no-controller timeout).

## Running-agents push (`agentkit:running-agents`)

Honest running-set telemetry for an external RPC controller: the extension
PUSHES the set of non-terminal subagents over the only existing push channel
(fire-and-forget extension UI `setStatus`) so the host can stop treating a Pi
session whose main turn ended as idle while background children still work
(zavod's node folds these frames into `RuntimeSummary.runningAgents` and
guards its idle timer with them). The set is derived from the same live
registry `inspect()` reads — never from disk markers or guesses.

Wire contract v1 (frozen with the consumer):

```json
{"type":"extension_ui_request","id":"<pi uuid>","method":"setStatus",
 "statusKey":"agentkit:running-agents","statusText":"<JSON string>"}
```

`statusText` is a JSON-encoded string:

```json
{"v":1,
 "agents":[{"id":"sa-3-x1","label":"review","state":"running"}],
 "count":1,
 "truncated":false}
```

- **Running set**: logical states `starting`, `running`, `waiting_input`
  (non-terminal), one row per agent, each row exactly `id`/`label`/`state`
  (label falls back to id when empty). Rows sorted by `startedAt` then `id`
  (deterministic frames). A terminal transition (completed/failed/cancelled)
  or a process exit removes the row and triggers a frame — no row outlives
  its agent.
- **`count`** is the TRUE number of running agents, even when rows are
  truncated.
- **Byte budget**: serialized `statusText` ≤ 64 KiB. When exceeded, the
  earliest rows that fit are kept and `truncated:true`; `count` stays true.
- **Emission**: only when the set signature changes (over sorted
  `[id,state,label]`; identical signature → no frame), plus one frame at
  runtime creation with the current set (usually empty) so the host sees the
  channel live, plus an unconditional empty-set frame at runtime shutdown
  (best-effort, before children are killed).
- **RPC-only gate**: `ctx.mode === "rpc"` captured from the session_start
  ctx. TUI/print never emit — no footer noise. A missing ctx/ui, a throwing
  registry read, or a failing `setStatus` leaves the emitter inert; telemetry
  never throws into spawn/lifecycle handlers.

Pure formatting/dedup/budget logic lives in `running-agents-push.ts`
(unit-tested without pi); the controller exposes a runtime-wide
records-changed hook (`onRecordsChanged`) with notifications at spawn, state
transitions (including `waiting_input` and its resolution), terminal
settlement, cancel/retire, process exit, and shutdown.

## Child environment

`pi --mode rpc --no-extensions -e bridge.ts` — no parent extension stack.
Generic children therefore cannot spawn recursively by construction; a
workspace worker additionally carries the subagents index (see the
workspace section) and may spawn plain `subagent` helpers. Normal
skills/context files stay on.
Per-spawn `cwd`, `label`, and `modelClass` (a free-form string, valid for
BOTH spawn modes; resolved to concrete model + thinking by the
model-classes resolver — routing-aware — before the process starts; see
`../model-classes/README.md`). Omitted, the spawn mode's routed default
applies (`/model-class route <plain|repoOwner> <class|inherit>`); with no
route a plain child inherits the current main session pair, while a
workspace (RepoOwner) child falls to the implicit default class `heavy`
when it is saved (else the session pair). An explicit saved class name
overrides all defaults, and `"default"` matches the live session
pair regardless of routing. A present route — or an unresolvable saved
`heavy` — that cannot be resolved (dead
class, hand-edited garbage target) or unreadable model-class storage fails
the spawn closed instead of silently inheriting. The runtime never maps roles to classes or
picks a class itself — routing and the saved `heavy` default are the user's
machine-global configuration.
The internal runtime boundary (`SpawnOptions`) still carries concrete
`model`/`thinking` because the child needs literal CLI flags.
Child sessions are ordinary pi sessions named `subagent:<label>`, inspectable
with standard tooling.

## Spawn waves and provider rate limits

Parallel children resolving to the same provider + model class share one rate
budget: a large same-model wave can draw HTTP 429s that kill several children
at once (observed on zai — children died ~2 minutes after dispatch). Mixed
waves are fine (e.g. three implement owners on `default` plus one reviewer on
`smart`); keep same-model waves small (<=3 in practice) or stagger them.
A 429-killed child is simply re-spawnable; the cost is lost work plus the
provider's rate-limit cooldown. There is deliberately no runtime concurrency
limiter — wave discipline is the caller's job.

## Lifecycle

States: `starting → running ⇄ waiting_input → completed | failed`, plus
`cancelled`. Run boundaries come from the child's own `agent_start` /
`agent_settled` events; run-local state (final text, run error) resets on
every run, so follow-up reruns start clean and a successful retry after a
transient provider error settles as `completed`. Process exit before settling
maps to `failed` (never a stuck `running`). Cancellation sends the pi `abort`
RPC, then SIGTERM (pi exits cleanly even while blocked in a UI dialog), then
SIGKILL after a grace period. `session_shutdown` kills all owned children;
`/subagents kill-all` uses the non-latching `cancelAll`, so new spawns keep
working afterwards.

## Input delivery

`steer` and `follow_up` both send `prompt` with a `streamingBehavior`, so pi —
not a controller-side copy of its state machine — atomically decides between
queueing and starting a run from the session's real state.

## Known limitations (v1)

- No durable execution across main restarts: if the main process dies, its
  children are cancelled or orphaned; a restarted main cannot reattach.
- Events for children of a previous main session are not re-delivered.
- A `pi.sendMessage` rejection (rare races, e.g. compaction in progress)
  surfaces only as a pi `extension_error` event; that delivery is then lost
  (the agent remains queryable via `subagent status` / `result`).

## Workspace spawn mode — RepoOwner contract

Workspace is a MODE of a `subagent` spawn, not a separate agent kind:
`subagent op=spawn workspace=<managed worktree> task=... deadlineSec=...`
runs a RepoOwner — a child rooted in a managed task worktree with a strict
protocol on top of the shared subagent runtime. Plain `cwd` spawns keep
working exactly as before (no ownership semantics, `modelClass` applies);
`modelClass` applies to workspace spawns identically — omitted, the
`repoOwner` routing default decides, else the implicit `heavy` class when
saved, else the main session's model + thinking —
and resolution failures classify as `blocked` (`dispatched:false`,
nothing started).

- **Per-spawn profile**: RepoOwner children load the task-workspace entry, a
  reporting bridge, the subagents index (so the owner can spawn plain
  `subagent` helpers — routing-aware modelClass applies to those too), and a
  readiness probe in addition to the base bridge
  (`SpawnOptions.additionalExtensions`; the probe comes last as a pure
  observer — no tools, no tool_call hooks). Generic children are
  byte-identical.
- **Readiness handshake**: before the task prompt is sent, a subagents-owned
  readiness probe (the last profile entry) reads the child's actual session
  tool set once from its `session_start` handler and reports it as a single
  fire-and-forget notify (blocking dialogs would deadlock — the child's
  stdin reader attaches only after `rebindSession`). The contract is
  MAIN-SIDE only: `PROFILE_READINESS` in readiness.ts declares the RepoOwner
  default the workspace layer passes per spawn, and the controller validates
  the observed tool set against it. The child carries no readiness policy;
  no readiness data travels to the child. Failures kill the child with the
  task never reaching a model (fail closed, `dispatched:false`).
- **Dispatch point**: readiness + RPC acceptance of the initial prompt.
  Everything before is `dispatched:false`; after it there is no fallback —
  abort detaches (the run continues), repair is a new RepoOwner spawn.
- **Event ownership**: RepoOwner lifecycle events route to the workspace run
  registry only. `subagent op=wait` continues a bounded wait on the SAME run
  through this registry (not the generic controller waiter). `steer` uses
  queue-only RPC steering between actions, never aborts a tool or starts a
  new run, and rejects settling/terminating/settled owners. `follow_up` is
  forbidden. `status`, `result`, `respond`, and `cancel` work in both modes.
- **Independent wait cap**: `waitTimeoutSec` on workspace spawn and
  `timeoutSec` on workspace wait cap continuous Main waiting (default 600s),
  independently of `deadlineSec`. Expiry returns `running`, `agentId`, the
  last progress, and deadline left. It does not release ownership, stop the
  child, or extend its absolute deadline. Terminal/needs_input already
  observed at release take priority; completion still arrives as an event.
- **Ownership**: canonical worktree paths are reserved synchronously before
  dispatch; duplicate concurrent spawns (including aliases) fail closed.
  Ownership is held through physical child stop and runtime Git reads. During
  reads, queries return a nonterminal settling/terminating state, never
  incomplete Git facts or a premature terminal; notification is sent once.
- **Progress**: separate `report_progress` replaces the previous bounded,
  runtime-timestamped progress atomically. It reports results, current work,
  an explicitly agent-reported blocker (optional), and next step, not command
  output or reasoning. It is not approval or an ownership release. Missing
  progress is explicitly not reported; missing observed active tool means
  activity unknown, not thinking/hung. Progress and observed tool durations
  remain separate in status, result, inherited inspection and `onUpdate`,
  including terminal/history views. See the additive consumer contract below.
- **Envelope**: the child reports its product outcome via `report_result`
  (typebox-validated, atomic file handoff). Any later tool call invalidates
  the report — settlement accepts only fresh envelopes, so "finish by
  reporting" is mechanical.
- **Settled-state verification (ADR-0003)**: a `done` product outcome is
  accepted only when Git reads the worktree as settled after the child was
  retired — accessible repository, current HEAD, clean tree (untracked
  non-ignored files count as dirt; ignored build output does not). A failed
  check settles the run `blocked` with a `done_rejected_*` reason and the
  report envelope is withheld. Every terminal outcome carries runtime-read
  `git_facts` (branch, HEAD SHA, dirty paths); Main never asks the model for
  these facts.
- **Deadline and ladder**: the deadline covers the whole run including report
  recovery. Settlement without a fresh envelope triggers up to 3 follow-ups;
  ladder exhausted before the deadline → `blocked`, deadline first →
  `partial` + `child_may_have_mutated_repo`. Deadline and explicit Main
  cancel use the real `cancel` (semantic cancellation).
- **Terminal lifecycle**: terminal outcomes `retire()` the child — kill the
  settled process while preserving the terminal record (never `cancelled`).
  Completion is announced through the shared `[subagent completed]` event
  channel with workspace fields — a few compact lines (status folded with
  the runtime-read branch/HEAD/dirty facts, the report summary, and
  check/scope metrics), never the raw envelope JSON; the terminal outcome
  stays queryable via
  `subagent op=result id=<agentId>` for the rest of the session. Runs are
  identified by their agentId; there is no separate run-id namespace.
- **Model selection**: the child runs on the explicit `modelClass`, else
  the `repoOwner` routing default, else the implicit `heavy` class when
  saved, else the main session's resolved model and thinking level; a
  resolution failure refuses the spawn (`blocked`). Main sees the current
  class pairs and effective defaults in the `subagent_model_defaults`
  system-prompt section (refreshed when they change).
- **Live operator observability**: while a workspace spawn waits, the tool
  call re-renders a compact status view via Pi's transient `onUpdate`
  channel (display-only — never Main's LLM context, child transcript stays
  isolated). The view shows run identity (agentId/workspace), run state
  (`running | waiting_input | settling | terminating`, plus
  `report recovery n/3` while the ladder is active), elapsed time and
  deadline left, pid, model/thinking, live session stats (cumulative cost
  and context-window fill, refreshed on every assistant message end and
  tool end via `get_session_stats`), the child's session id, and the
  child's authoritative tool activity: `tool_execution_start` opens the
  current tool (name + a conservatively bounded argument preview from a
  tool-aware policy: bash/powershell → command, read/edit/write → path,
  grep/find → pattern, web_search → query; unknown tools get NO summary and
  `url` is never surfaced — never full argument blobs, never output),
  `tool_execution_end` moves it into a hard-capped recent list (4 entries).
  Session identity is fetched with a single `get_state` right after prompt
  acceptance, so it is visible while the child runs, not only after
  settlement. The refresh loop ticks every 3 s and is stopped on every exit
  path: terminal, needs_input, wait timeout, detach, and thrown errors. Plain spawns get
  the same live progress on `subagent op=wait` (state, current tool, bounded
  recent activity) — observability is a property of `subagent`, not a reason
  to pick a workspace spawn.

Live verification: `node live/workspace-verify.mjs` (spawns a real main pi
process and real children on the default model; covering the acceptance
scenarios A1–A3b, A5–A9, A11–A14 plus the fail-closed profile proof L10 —
missing entry → no process; broken capability → readiness fails, child
killed, task never dispatched).

## ZAVOD-39 additive consumer contract

All additions are optional; old snapshots, outcomes and history remain valid.
The existing producer is `agentDetailView()` → inherited inspection
`area=subagents` → `data.agents[].run` (also `subagent op=status`). No
`task_current` changes or new transport. The same narrow projection appears
in `onUpdate.details.run` and ongoing `op=result.details.run`.

```ts
type Progress = {
  achieved: string;
  currentWork: string;
  blocker?: string; // only an explicit agent claim, never an environment verdict
  nextStep: string;
  updatedAt: number; // Unix ms, assigned by runtime
};
// Optional additions to live run and workspace protocol outcomes:
// progress?: Progress; progressAgeMs?: number; deadlineAt?: number;
```

Each text is at most 1000 UTF-16 code units; control characters are normalized
and whitespace flattened. `report_progress` accepts only the four input
keys above, never `updatedAt`. `progressAgeMs = max(0, now - updatedAt)` is
computed on reads, never persisted as truth. `deadlineAt` is absolute Unix
ms; existing `deadlineMsLeft` is preserved. Snapshot `activeTool.startedAt`
and bounded `recentActivity` remain independently observed activity. No
child identity is inferred from a tool argument.

Persistence has two additive forms:

1. Independent atomic handoff at `results/progress-<sanitizedAgentId>.json`:
   `{ "agentId": string, "progress": Progress }`. It is bounded and validated
   on reads and survives final reporting, cancel and deadline.
2. Existing `results/<sanitizedAgentId>.json` (`AgentResult`) gains optional
   `run?: RunHistory`, containing precisely:

```ts
type RunHistory = {
  workspace: string;
  state: string; // running at accepted marker, settled at final publication;
                 // lost when a running marker is reconciled after parent restart
  deadlineAt?: number;
  progress?: Progress;
  status?: "done" | "partial" | "blocked"; // protocol, not product status
  terminal?: {
    status: "done" | "partial" | "blocked";
    reason?: string;
    result?: { status: "done" | "partial" | "blocked"; summary: string };
  };
};
```

`run` contains no transcript, tool output, Git facts, recovery ladder,
`deadlineMsLeft` or `progressAgeMs`. Controller result writes preserve this
metadata; final workspace publication rewrites it only after child stop and
Git reads. A restart can recover last progress from the independent handoff
for a reconciled lost marker. The base `AgentResult.status` is the child
controller result, not workspace protocol settlement: only `run.terminal`
records workspace terminal publication. History is a frozen observation,
NEVER proof of a live/resumable owner, even when its saved state is running.

Workspace spawn/wait outcomes persist naturally in Pi tool-result `details`
(the outcome itself; `op=result` wraps it in `details.result`). These outcomes
also carry optional `progress`, `progressAgeMs`, `deadlineAt`, compatible
`deadlineMsLeft`, and terminal `git_facts`. Their saved age/deadline-left are
point-in-time values: consumers recompute elapsed age from `updatedAt`, and
must not infer liveness from history. Absent/malformed optional progress
should be displayed as not reported; no progress is required for completion.

### `lastAssistantText` — automatic last public speech (UX revision)

Optional additive channel at the **AgentSnapshot/AgentResult root** (plain and
workspace children alike), separate from `Progress`/`RunHistory` and from the
product report:

```ts
type LastAssistantText = {
  text: string; // normalized, max 512 UTF-16 code units
  updatedAt: number; // Unix ms, assigned by the runtime at acceptance
};
// AgentSnapshot.lastAssistantText? / AgentResult.lastAssistantText?
```

Single source: the child's completed RPC `message_end` with `role=assistant` —
`type=text` content blocks only, joined in order. Thinking, tool calls, tool
results, delta streams and full transcripts never enter. Messages with
`stopReason` error/aborted/deferred (or pending) and empty-after-normalization
text never replace an accepted fragment. Text is normalized (control
characters → space, whitespace folded, trimmed) and capped AFTER
normalization at 512 UTF-16 code units; only the single last fragment is
kept and a newer completed message replaces it.

Acceptance is bounded to non-terminal records: a `message_end` arriving after
the record settled cannot mutate the terminal record. No new sidecar or log:
persistence rides the existing result path — the spawn-time `running` marker
is rewritten on every accepted change, the terminal write keeps the fragment,
and lost-run reconciliation (`run.state: "lost"`) retains it when well-formed
(malformed optional values are dropped, never forwarded). The projection is
available immediately in narrow inspection `area=subagents`
(`data.agents[].lastAssistantText`, via `agentDetailView`), `subagent
op=status`, `subagent op=result` (`details.result` root for plain agents) and
persisted history. Absence is meaningful: the child has produced no public
speech yet — it is never inferred from silence about blockers or activity.

Dev note: `bun test` needs `typebox` resolvable from the repo tree —
`ln -s <pi-package>/node_modules/typebox node_modules/typebox` (gitignored).
