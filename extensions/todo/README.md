# todo — phased todo-list extension for pi

Port of oh-my-pi's built-in todo subsystem as a pi extension.

## Surfaces

- **`todo` tool** (LLM): phased list (`TodoPhase → TodoItem`), ops
  `init / start / done / drop / block / unblock / rm / append / view`.
  Tasks are addressed by verbatim content, never IDs; duplicates are rejected;
  a batch with any error is discarded whole. A missing `op` is repaired from
  the payload shape. The full behavioral contract lives in the tool description
  (`prompts/tool-description.md`).
- **Transcript card**: phase headers with roman numerals and `closed/total`
  progress, status-colored task lines, collapsed "walking viewport" (last
  closed task leads, active work pulled to the head, hidden-count summary).
- **Sticky HUD** above the editor: continuous progress spine along the phase
  tree, collapsed to the active stage; single-line compact mode on short
  terminals; auto-clears `hudClearDelaySec` after every task is settled.
- **Reminders** (`reminders.ts`): stop-time `<system-reminder>` with a budget
  (`remindersMax`, reset per user prompt and whenever nothing is open) and
  guards (a prior reminder still awaiting progress; the agent stopping to ask
  the user a question). Hidden mid-run nudges after `midRunMutationThreshold`
  mutating tool calls without a todo touch, at most `midRunMaxPerCycle` per
  cycle.
- **Eager prelude** (`eager: "preferred"`): a hidden "consider creating a
  list" reminder on the first user prompt. Off by default, matching OMP
  defaults.
- **`/todo`**: markdown snapshot; `/todo expand` / `/todo collapse` for the HUD.

## State and persistence

State lives in tool-result details and is rehydrated from the session branch
(`latestPhasesFromEntries`), so branching, rewinding, and resuming restore the
list for free. No external files, no mirror entries.

## Layout

- `core.ts` — pure domain model, ops, markdown, inference (no pi imports)
- `reminders.ts` — reminder engine and question heuristics (pure)
- `render.ts` — transcript card + HUD rendering (imports pi-tui)
- `index.ts` — wiring: tool, events, widget, command
- `prompts/*.md` — tool description, eager prelude, mid-run nudge texts

## Tests

```sh
bun test extensions/todo/
```

The pure modules carry contract tests ported from the OMP suite (ops
invariants, wholesale discard, inference, collapsed viewport, reminder budget
and guards, markdown, rehydration precedence) plus rendering tests against the
real `pi-tui` line utilities.

## Install

From the repo checkout you want live:

```sh
bin/agent-kit install
```

`agent-kit install` links every extension in `extensions/` into
`~/.pi/agent/extensions` for the pi host.
