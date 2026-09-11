# pi-tuning

Workspace for [pi](https://github.com/badlogic/pi-mono) extensions and configuration
tuning, ported from my oh-my-pi setup.

## Contents

- `extensions/todo/` — phased todo-list extension: `todo` tool with transcript
  persistence, sticky HUD widget, stop-time and mid-run reminders, eager prelude.
  Ported from oh-my-pi's built-in todo subsystem.
- `extensions/perf-stats/` — omp-style usage row under each assistant response:
  local timestamp, prompt→yield Δ, input (cache writes folded in), output and
  cache-read tokens, TTFT, tok/s over the full request duration; plus per-tool
  execution time.
- `extensions/web-search/` — `web_search` tool over the ChatGPT Codex backend's
  hosted web search, reusing pi's `/login openai-codex` OAuth credential (no
  separate auth). Forced hosted tool, SSE parsing, citations/source
  deduplication, typed failures, compact model-facing output.
- `extensions/continue-shortcut/` — `.`/`c` continue shortcut: submitting a
  bare dot resumes the agent with a hidden continue directive instead of a
  visible user message. Ported from oh-my-pi's input-controller shortcut;
  queued as a follow-up while the agent is busy, no-op mid-stream, passthrough
  with images.
- `extensions/subagents/` — native subagent runtime: each subagent is an
  independent `pi --mode rpc` process with its own session, owned by the main
  process. One compact `subagent` tool (spawn/status/steer/follow_up/wait/
  result/respond/cancel), async-first, background completion/escalation
  delivery at safe turn boundaries, child transcripts never enter main context.
  See `extensions/subagents/README.md`.

## Layout

Each extension is self-contained under `extensions/<name>/`: pure logic modules,
rendering, wiring entry (`index.ts`), prompt texts as `.md` files, and `bun test`
unit tests for the pure core.

## Install

Symlink the extensions of this checkout into the pi extensions directory:

```sh
./install.sh                # everything under extensions/
./install.sh todo           # only the named entities
./install.sh --prune        # also drop dangling links into deleted pi-tuning checkouts
```

Run it from the worktree you want pi to load: links are repointed at that
checkout, the previous target is never modified, and dangling links from
deleted worktrees are replaced. Without arguments the last run wins — with
several active worktrees, pass explicit entity names.
