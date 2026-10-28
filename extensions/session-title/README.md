# session-title

Names a session from its first user message so the terminal tab shows the
task, not just the project folder. On the first prompt of a TUI session it
asks a cheap model for a concise title and applies it via
`pi.setSessionName()`. In TUI mode the extension owns the OSC 0 terminal
title: it paints the bare session name and overrides pi's composed
`π - <name> - <cwd>` format; clearing the name restores pi's default.

## Model selection

1. The model bound to the `explore` role in `<agent-dir>/subagent-roles.json`
   (managed with `/subagent-role explore <provider/id>`; a trailing
   `:thinking` is ignored), if that model exists in the registry and has
   configured auth;
2. otherwise the active session model.

No new configuration surface: bind `explore` once and every naming call
reuses it.

## Guarantees

- **Never delays the turn.** Generation is fire-and-forget off the
  `before_agent_start` path; the title lands whenever the model answers.
- **Manual names always win.** A name set via `/name` (before or during
  generation) is respected; the name is re-checked immediately before writing.
- **One attempt per session.** No retry loop, no re-naming on later messages;
  the attempt flag resets on `/new`, `/resume`, `/fork`.
- **Silent failures.** Missing auth, model errors, aborts, and the 120 s
  timeout leave the session unnamed and are never surfaced as errors.
- **TUI only.** `-p`, json, and rpc modes never trigger naming.

## Tests

`bun test` in this directory covers prompt construction, response
sanitization (fences, quotes, truncation by code points), and explore-binding
parsing, including model ids that contain slashes.
