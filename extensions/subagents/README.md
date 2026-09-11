# subagents

Native pi subagent runtime: each subagent is an independent `pi --mode rpc`
process with its own session, cwd, and lifecycle, owned by this extension in
the main process. No daemon, no shared hub.

## Surfaces

- **`subagent` tool** (LLM): one compact tool with ops
  `spawn / status / steer / follow_up / wait / result / respond / cancel`.
  `spawn` is asynchronous by default — it returns an id immediately and the
  child works in parallel. Blocking on a child is modeled as `wait`, not as a
  special agent type.
- **Background delivery**: when a child reaches `completed`, `failed`, or
  `needs_input`, the main model receives a few compact lines via
  `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`. Pi 0.85.1
  delivers this at the next safe turn boundary when main is busy and starts a
  fresh run when main is idle (both verified against the installed version).
- **`/subagents` command**: compact live status table; `/subagents kill-all`
  terminates everything.

## Context discipline

The child transcript never enters main context. The model sees only the short
event message; the full final result, session location, timestamps, token
usage, and failure reason live in a persisted result file
(`$PI_CODING_AGENT_DIR/subagents/results/<id>.json`, default
`~/.pi/agent/subagents/results/`), fetched lazily via `subagent op=result`.

## Escalation (`ask_parent`)

Children run with a minimal bridge extension (`bridge.ts`) that registers one
tool: `ask_parent`. It blocks the child (only the child) on the standard RPC
extension UI protocol (`extension_ui_request`, method `input`, title
`ask_parent`). The controller surfaces it to main as `needs_input`; main (or
the user) answers via `subagent op=respond`, and the same child tool call
resumes. A generous timeout (default 30 min, `PI_SUBAGENT_ASK_TIMEOUT_MS`)
prevents forever-blocked orphans if main dies.

## Child environment

`pi --mode rpc --no-extensions -e bridge.ts` — no parent extension stack, no
recursive spawning by construction. Normal skills/context files stay on.
Optional per-spawn `model`, `thinking`, `cwd`, `label`. Child sessions are
ordinary pi sessions named `subagent:<label>`, inspectable with standard
tooling.

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

## Workspace layer (`workspace_agent`) — RepoOwner contract

`workspace_agent(workspace, task, timeout_ms?)` runs a RepoOwner: a child
rooted in a managed task worktree with a strict protocol around the shared
subagent runtime.

- **Per-spawn profile**: RepoOwner children load the task-workspace entry and
  a reporting bridge in addition to the base bridge (`SpawnOptions.
  additionalExtensions`). Generic children are byte-identical to before.
- **Readiness handshake**: before the task prompt is sent, each profile entry
  confirms initialization from its `session_start` handler (fire-and-forget
  notify carrying the registered tool set; blocking dialogs would deadlock —
  the child's stdin reader attaches only after `rebindSession`). The
  controller validates entry ids, `ok`, and required tools; failures kill the
  child with the task never reaching a model (fail closed, `dispatched:false`).
- **Dispatch point**: readiness + RPC acceptance of the initial prompt.
  Everything before is `dispatched:false`; after it there is no fallback —
  abort detaches (the run continues), repair is a new RepoOwner.
- **Event ownership**: RepoOwner lifecycle events route to the workspace run
  registry only — no generic `[subagent ...]` deliveries, and `wait()` is
  locked. The `subagent` tool on RepoOwner children allows only
  `status / result / respond / cancel`; `wait / steer / follow_up` are
  rejected with an explanation.
- **Envelope**: the child reports its product outcome via `report_result`
  (typebox-validated, atomic file handoff). Any later tool call invalidates
  the report — settlement accepts only fresh envelopes, so "finish by
  reporting" is mechanical.
- **Deadline and ladder**: the deadline covers the whole run including report
  recovery. Settlement without a fresh envelope triggers up to 3 follow-ups;
  ladder exhausted before the deadline → `blocked`, deadline first →
  `partial` + `child_may_have_mutated_repo`. Deadline and explicit Main
  cancel use the real `cancel` (semantic cancellation).
- **Terminal lifecycle**: terminal outcomes `retire()` the child — kill the
  settled process while preserving the terminal record (never `cancelled`).
  Completion is announced as `[workspace_agent completed]`; the result stays
  queryable via `workspace_agent(run_id)` for the rest of the session.
- **Model pinning**: the child runs with the main session's resolved model
  and thinking level; without a model the dispatch is refused (`blocked`).

Live verification: `node live/workspace-verify.mjs` (spawns a real main pi
process and real children on the default model; 28 checks covering the
acceptance scenarios A1–A3b, A5–A9, A11–A14).

Dev note: `bun test` needs `typebox` resolvable from the repo tree —
`ln -s <pi-package>/node_modules/typebox node_modules/typebox` (gitignored).
