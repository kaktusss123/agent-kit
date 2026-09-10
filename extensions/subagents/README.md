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
(`<childCwd>/.pi/subagents/results/<id>.json`), fetched lazily via
`subagent op=result`.

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

States: `starting → running ⇄ waiting_input → completed | failed`,
plus `cancelled`. Process exit before settling maps to `failed` (never a
stuck `running`). Cancellation sends the pi `abort` RPC, then SIGTERM (pi
exits cleanly even while blocked in a UI dialog), then SIGKILL after a grace
period. Main session shutdown kills all owned children.

## Known limitations (v1)

- No durable execution across main restarts: if the main process dies, its
  children are cancelled or orphaned; a restarted main cannot reattach.
- `follow_up` on an idle child is translated into a plain `prompt` in the
  same session, because pi 0.85.1 queues `follow_up` forever without starting
  a run when the agent is idle.
- Events for children of a previous main session are not re-delivered.
