# Pi skill reflection

Prerequisites: Node.js and the project-local Pi 1.5.0 test runtime described in CONTRIBUTING.md. This scenario does not call a model or read active user sessions.

Drive:

```sh
node --test --test-timeout=180000 extensions/skill-reflection/*.test.ts
```

Expected: the reminder is advisory context on a naturally occurring real user turn, roughly every eight user messages, only after a skill has actually loaded successfully on the active session branch. Available skill descriptions and failed reads alone do not qualify. Tool loops, retries, custom/automated messages and subagents neither advance cadence nor start a reminder turn. Reload, new session, fork and tree navigation recover only branch-relevant state without duplicate reminders. Paths and injected content remain bounded. Tests exercise the actual Pi loader/session boundary as well as deterministic edge cases.

Evidence: per-case results and loader/RPC diagnostics, including no model-call or continuation evidence. A mock-only run does not prove lifecycle integration. No expected side effect includes editing skills, notifying the user repetitively, archiving transcripts or scheduling another LLM run. Shared `reflect` remains manually usable in other hosts; this Pi hook does not run in Claude Code or Codex.

Cleanup: tests remove only their isolated session/config roots. Preserve failure output before removal; do not inspect other sessions to diagnose this scenario.
