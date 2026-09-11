# agent-events — semantic runtime events for pi

Observes pi's lifecycle hooks and publishes a small terminal-agnostic event
model to pluggable sinks. Today the only sink is **Warp** (Warp CLI Agent
Protocol v1 over OSC 777); a future headless control-plane transport is just
another sink — no pi lifecycle code changes required.

There is no LLM-facing tool: lifecycle is observed automatically, the model
cannot emit status events.

## Event model (semantic, terminal-agnostic)

| Event | Pi source | Notes |
|---|---|---|
| `session_started` | `session_start` | re-emitted on `/new`, `/resume`, `/fork` (new session id) |
| `run_started` | `agent_start` + `before_agent_start` | carries the truncated user query (200 code points) |
| `run_completed` | `agent_settled` | last assistant `stopReason` is a normal stop |
| `run_failed` | `agent_settled` | `stopReason: "error"`; carries `error`/`response` |
| `run_aborted` | `agent_settled` | `stopReason: "aborted"` (user interrupt) |
| `attention_required` | `ui_prompt_start` | any blocking `ctx.ui.*` prompt (permission gates, questions) |
| `attention_resolved` | `ui_prompt_end` | prompt closed |

`agent_settled` (not `agent_end`) is the completion point so Warp never
flashes a final state during auto-retry, compaction retries, or queued
follow-up continuations.

Events intentionally carry no transport fields (no `v`, `agent`, `session_id`,
`cwd`, `project`, timestamps, tool previews) — sinks add their own envelope.

## Warp mapping (protocol v1, verified against warpdotdev/warp source)

| Semantic | Warp event | Warp status effect |
|---|---|---|
| `session_started` | `session_start` | registers the session (`plugin_version`) |
| `run_started` | `prompt_submit {query}` | → InProgress |
| `run_completed` | `stop {query, response}` | → Success |
| `run_failed` | `stop_failure {query, response, error_type:"error"}` | → Failed |
| `run_aborted` | `stop_failure {query, error_type:"cancelled"}` | → Failed (cancelled) |
| `attention_required` | `question_asked {summary: title \|\| "Waiting for your <kind>"}` | → Blocked |
| `attention_resolved` | `permission_replied` | Blocked → InProgress |

Wire frame (BEL terminator, raw JSON body):

```
ESC ] 777 ; notify ; warp://cli-agent ; {"event":...,"v":1,"agent":"pi",...} BEL
```

Envelope fields (`v`, `agent:"pi"`, `session_id`, `cwd`, `project`,
`plugin_version`) are appended by the sink; `cwd`/`project` are re-read per
emit. Under tmux the frame is DCS-wrapped with doubled ESC bytes
(`ESC P tmux; ... ESC \`), and attention-worthy events (run outcomes,
`attention_required`) append one outer BEL so tmux monitor-bell flags the pane.

## Terminal sink gating

Only the top-level interactive session may create the Warp sink:

1. `ctx.mode === "tui"` — excludes `-p`/json/rpc runs;
2. `process.stdout.isTTY` — excludes subagent/headless processes whose stdio
   is a pipe or socket (they inherit Warp's env vars, so env checks alone are
   not enough);
3. `WARP_CLI_AGENT_PROTOCOL_VERSION >= 1` — Warp must advertise the protocol;
   without it nothing is ever emitted.

Outside those conditions the extension subscribes but stays silent. Sink write
failures are swallowed and can never break agent execution.

## Layout

- `events.ts` — semantic event types, `AgentEventSink`, terminal gate.
- `classify.ts` — run outcome classification from `agent_end` messages;
  code-point-safe truncation.
- `warp.ts` — capability check, OSC 777 framing, tmux passthrough (pure).
- `warp-sink.ts` — `WarpCliAgentSink`: semantic → Warp mapping + emission.
- `index.ts` — extension wiring: subscriptions, query tracking, gating.

## Adding another sink later

Implement `AgentEventSink { emit(event) }` and subscribe it in `index.ts`
next to (or instead of) the Warp sink. No protocol code outside `warp*.ts`.

## Tests

`bun test` in this directory covers capability gating, the exact wire format,
tmux framing, semantic→Warp mapping, run classification, and the extension
lifecycle (including headless/non-TTY silence and sink error swallowing).
