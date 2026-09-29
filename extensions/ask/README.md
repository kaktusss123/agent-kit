# ask

Portable `ask` — the single model-facing question tool for pi, ported from
oh-my-pi's `ask` (reference contract) and shared by every role:

- **Interactive main** registers this extension: the model calls `ask` with
  OMP-style structured questions; the user answers through a rich TUI dialog
  (editor replacement; tabs/navigation, single/multi-select, recommended hints, option
  descriptions and previews, free-form `Type a response…`, and a review screen).
  On RPC-mode mains it degrades to the standard pi extension UI dialogs,
  speaking the ask-v2 wire format (each select option is a JSON string with
  `kind`/`label`/`desc`/`preview`/`rec` plus one `kind: meta` item per
  dialog; replies match emitted strings verbatim). The review step offers
  per-question revise, submit, and revise-all — the summary itself is not
  selectable. Without any interactive UI (print/json/headless) the tool fails
  closed — it returns an explicit unavailable error and never pretends
  someone answered. Cancelling (explicit interrupt, dismissed dialog, or
  three unknown RPC replies) aborts the agent turn (OMP parity) and carries
  `partialResults` in the outcome/details so the transcript can render the
  questions already answered. There is no Chat control on any surface
  (ZAVOD-30 D7): free-form input covers the "discuss it" case.
- **Subagents** never load this extension. The subagents bridge registers the
  same `ask` (same name, same schema, same role-neutral description — proven
  by parity tests); the structured request travels to the controller, which
  raises a structured `needs_input` to main. See
  `../subagents/README.md` ("Escalation").

## Files

- `contract.ts` — canonical types, validation, argument repair, formatting.
  Free of pi and typebox imports (unit-testable anywhere).
- `ask-schema.ts` — the typebox twin of the schema used by tool registration.
- `core.ts` — pure dialog state machine: rows, selection, navigation, review,
  results.
- `dialog.ts` — rich TUI editor-replacement component on pi-tui primitives.
- `tool.ts` — pi-free tool builder; the environment seam is the injected
  `AskBackend` (rich dialog / RPC fallback / fail-closed).
- `index.ts` — extension entry wiring the backend per execute context.

## Argument repair

Both registration sites (Main `tool.ts`, child `bridge-ask.ts`) set
`prepareArguments` to `normalizeAskArguments` (contract.ts), so the malformed
shapes models actually emit are repaired before the strict typebox schema
rejects the whole call:

- `recommended: true` embedded in individual options instead of a zero-based
  index on the question (observed real-world failure) — moved to
  `question.recommended` (first flagged option wins);
- question-level `recommended` given as a boolean (`true` → first option) or
  as an option label string (exact match, then trimmed case-insensitive);
  unmatchable label strings are kept raw so the schema rejects the call;
- unknown extra properties at any level are dropped — the model-facing twin
  of the lenient transport validation in `validateAskInput`.

Anything unrepairable passes through unchanged, so the strict schema still
produces a precise validation error. Recognized fields with wrong-typed
values are likewise preserved, never dropped — silently omitting e.g. a
non-boolean `multi` would turn a multi-select question into single-select.
The public schema stays strict; `ask-schema.ts` descriptions steer models
to the canonical shape.
