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

## Child environment

`pi --mode rpc --no-extensions -e bridge.ts` — no parent extension stack, no
recursive spawning by construction. Normal skills/context files stay on.
Per-spawn `cwd`, `label`, and `modelClass` (`cheap | default | smart`,
default `default`; resolved to concrete model + thinking by the
model-classes resolver before the process starts — see
`../model-classes/README.md`). Which class to use is the caller's explicit
per-spawn choice (Main decides via the tool's prompt guidelines: default =
ordinary work, cheap = high-volume low-stakes, smart = critical review /
escalation); the runtime never maps roles to classes or picks a class
itself. The internal runtime boundary (`SpawnOptions`) still carries
concrete `model`/`thinking` because the child needs literal CLI flags.
Child sessions are ordinary pi sessions named `subagent:<label>`, inspectable
with standard tooling.

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

- **Per-spawn profile**: RepoOwner children load the task-workspace entry, a
  reporting bridge, and a readiness probe in addition to the base bridge
  (`SpawnOptions.additionalExtensions`; the probe comes last as a pure
  observer — no tools, no tool_call hooks). Generic children are
  byte-identical to before.
- **Readiness handshake**: before the task prompt is sent, a subagents-owned
  readiness probe (the last profile entry) reads the child's actual session
  tool set once from its `session_start` handler (fire-and-forget notify per
  contract entry; blocking dialogs would deadlock — the child's stdin reader
  attaches only after `rebindSession`). Capability extensions declare
  nothing about readiness; the contract has a single home inside subagents
  (`PROFILE_READINESS` in readiness.ts is the declared RepoOwner default the
  workspace layer passes) and travels PER-SPAWN to the child via the
  `PI_SUBAGENT_READINESS_CONTRACT` env var — the probe reports exactly what
  its controller declared for this spawn (no/invalid env contract → no
  handler, fail closed). The controller validates entry ids, `ok`, and
  required tools; failures kill the child with the task never reaching a
  model (fail closed, `dispatched:false`).
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
- **Live operator observability**: while a blocking dispatch waits, the tool
  call re-renders a compact status view via Pi's transient `onUpdate`
  channel (display-only — never Main's LLM context, child transcript stays
  isolated). The view shows run identity (runId/agentId/workspace), run
  state (`running | waiting_input | settling | terminating`, plus
  `report recovery n/3` while the ladder is active), elapsed time and
  deadline left, pid, model/thinking, the child's session id, and the
  child's authoritative tool activity: `tool_execution_start` opens the
  current tool (name + conservatively bounded argument preview:
  command/path/pattern/query — never full argument blobs, never output),
  `tool_execution_end` moves it into a hard-capped recent list (4 entries).
  Session identity is fetched with a single `get_state` right after prompt
  acceptance, so it is visible while the child runs, not only after
  settlement. The refresh loop ticks every 3 s and is stopped on every exit
  path: terminal, needs_input, detach, and thrown errors.

Live verification: `node live/workspace-verify.mjs` (spawns a real main pi
process and real children on the default model; covering the acceptance
scenarios A1–A3b, A5–A9, A11–A14 plus the fail-closed profile proof L10 —
missing entry → no process; broken capability → readiness fails, child
killed, task never dispatched).

Dev note: `bun test` needs `typebox` resolvable from the repo tree —
`ln -s <pi-package>/node_modules/typebox node_modules/typebox` (gitignored).
