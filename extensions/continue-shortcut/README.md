# continue-shortcut — `.`/`c` continue shortcut for pi

Port of oh-my-pi's killer continue shortcut as a pi extension. Submitting a
bare `.` (or `c`) resumes the agent with a hidden agent-authored continue
directive instead of a visible user message, so the model continues prior
intent rather than reacting to a stray dot.

## Behavior

- **`.` or `c` while idle** — the raw input is swallowed (no user message in
  the session) and a hidden continue directive is injected, which starts a
  fresh run: "resume most recent intent, complete unfinished work, never stop
  to re-confirm".
- **`.` or `c` while the agent is busy** — the directive is queued as a
  follow-up and delivered after the current run settles (pi ignores the
  turn trigger while streaming; `deliverAs: "followUp"` degrades gracefully).
- **`.` or `c` mid-stream in the TUI** (explicit `steer` submission) — no-op,
  matching OMP where the shortcut only fires while idle.
- **`.` or `c` with attached images** — passes through as a normal message.
  Deliberate deviation from OMP, which would silently drop the images.

## How it works

- `input` event: sees the raw text before any expansion. `{ action: "handled" }`
  suppresses the user turn entirely.
- `pi.sendMessage({ customType, content, display: false }, { deliverAs:
  "followUp", triggerTurn: true })`: hidden message that participates in LLM
  context (serialized to the model as a user-role message — pi extensions
  cannot create OMP's developer-role messages) and starts the run when idle.
- The directive text is OMP's `prompts/system/manual-continue.md`, verbatim.

## OMP semantics not ported

- **Developer-role attribution**: pi has no extension path to a `developer`
  message; the directive lands as a hidden custom message.
- **`userInitiated` turn-time anchoring**: OMP anchors the turn's prompt time
  to the shortcut; pi owns turn attribution internally and extensions cannot
  set it.

## Layout

- `core.ts` — pure matching/guard decision (no pi imports)
- `index.ts` — wiring: `input` event → decision → hidden directive
- `prompts/manual-continue.md` — the continue directive text

## Tests

```sh
bun test extensions/continue-shortcut/
```

Matching matrix (`.`, `c`, whitespace padding, `C`/`..`/`c.` lookalikes) and
the guards (images, steer, followUp).

## Install

```sh
./install.sh continue-shortcut
```
