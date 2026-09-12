# ask

Portable `ask` — the single model-facing question tool for pi, ported from
oh-my-pi's `ask` (reference contract) and shared by every role:

- **Interactive main** registers this extension: the model calls `ask` with
  OMP-style structured questions; the user answers through a rich TUI dialog
  (editor replacement; tabs/navigation, single/multi-select, recommended hints, option
  descriptions and previews, free-form `Type a response…`, a review screen, and
  `Chat about this`). On RPC-mode mains it degrades to the standard pi
  extension UI dialogs (select/input per question plus a review step).
  Without any interactive UI (print/json/headless) the tool fails closed —
  it returns an explicit unavailable error and never pretends someone
  answered. Dismissing the question (Esc) aborts the agent turn (OMP
  parity) — `ask` is called only when the missing answer is material, so a
  dismissal is a cancellation, not a license to continue on uncertainty;
  `Chat about this` remains a normal outcome.
- **Subagents** never load this extension. The subagents bridge registers the
  same `ask` (same name, same schema, same role-neutral description — proven
  by parity tests); the structured request travels to the controller, which
  raises a structured `needs_input` to main. See
  `../subagents/README.md` ("Escalation").

## Files

- `contract.ts` — canonical types, validation, formatting. Free of pi and
  typebox imports (unit-testable anywhere).
- `ask-schema.ts` — the typebox twin of the schema used by tool registration.
- `core.ts` — pure dialog state machine: rows, selection, navigation, review,
  results.
- `dialog.ts` — rich TUI editor-replacement component on pi-tui primitives.
- `tool.ts` — pi-free tool builder; the environment seam is the injected
  `AskBackend` (rich dialog / RPC fallback / fail-closed).
- `index.ts` — extension entry wiring the backend per execute context.
