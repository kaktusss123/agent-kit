# session-title

Names a session from its first user message so the terminal tab shows the
task, not just the project folder. On the first prompt of a TUI session it
asks a cheap model for a concise title and applies it via
`pi.setSessionName()`; pi already renders the session name in the OSC 0
terminal title (`π - <name> - <cwd>`).

## Model selection

1. The saved `cheap` class from `<agent-dir>/model-classes.json`
   (the `model-classes` extension's artifact), if that model exists in the
   registry and has configured auth;
2. otherwise the active session model.

No new configuration surface: configure `/model-class cheap set` once and
every naming call reuses it.

## Guarantees

- **Never delays the turn.** Generation is fire-and-forget off the
  `before_agent_start` path; the title lands whenever the model answers.
- **Manual names always win.** A name set via `/name` (before or during
  generation) is respected; the name is re-checked immediately before writing.
- **One attempt per session.** No retry loop, no re-naming on later messages;
  the attempt flag resets on `/new`, `/resume`, `/fork`.
- **Silent failures.** Missing auth, model errors, aborts, and the 20 s
  timeout leave the session unnamed and are never surfaced as errors.
- **TUI only.** `-p`, json, and rpc modes never trigger naming.

## Tests

`bun test` in this directory covers prompt construction, response
sanitization (fences, quotes, truncation by code points), and saved-class
parsing, including model ids that contain slashes.
