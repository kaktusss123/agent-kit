---
description: Lightweight specification for straightforward features — quick clarification and handoff-ready spec
agent: fast-spec-analyst
---

<!-- markdownlint-disable MD041 -->

# /spec-lite — Lightweight Specification

Route this command to the `fast-spec-analyst` agent with `$ARGUMENTS` as the user input.

## Inputs

- `$ARGUMENTS` — Free-text straightforward change request. May contain a ticket pattern (e.g. `EVODP-1234`) and zero or more path-like or repo-like references.

## Empty-Input Guard (EC-02, VR-01, D-017)

If `$ARGUMENTS` is empty or whitespace-only, do not start the workflow. Return this usage message and stop:

```text
Usage: /spec-lite <straightforward change request>

Provide a short description of the change you want specified.
Examples:
  /spec-lite add a /health endpoint that returns {"status":"ok"}
  /spec-lite rename User.email to User.contact_email in the API
  /spec-lite fix flaky test in tests/test_auth.py
```

## Task-ID Derivation (D-009)

Derive the task ID from `$ARGUMENTS` using the same rules as `/spec`:

1. **Ticket pattern**: if `$ARGUMENTS` contains a token matching `[A-Z][A-Z0-9]+-\d+` (e.g. `EVODP-1234`), use it as the task ID.
2. **Slug fallback**: if no ticket pattern is present, take the first 4–6 meaningful words, lowercase, and join with `-` to form a kebab-case slug. Strip filler words.
3. **Collision avoidance**: if `docs/specs/<slug>.md` already exists at the lightweight location, append `-1`, `-2`, ... until a free filename is found.

The lightweight spec file is `docs/specs/<slug>.md`.

## Capability-Aware Preflight (FR-017, D-016, D-012, EC-05)

`fast-spec-analyst` has `bash: deny`, so preflight must NOT depend on bash. Use a string-pattern extraction step plus read/glob-based probing:

1. **Detect references**: extract tokens that look like absolute paths, relative paths, `~/`-prefixed paths, or `file://` URIs using string pattern matching only (no shell expansion, no `ls`, no `stat`). Deduplicate the list (EC-05).
2. **Probe accessible paths**: for each detected reference, attempt access with `read` or `glob` only.
3. **Classify each reference** as one of:
   - `in-workspace` — inside the current working directory tree and successfully probed.
   - `allowed-external` — outside the workspace but readable.
   - `needs-approval` — not yet accessible; surface to the user.
   - `unresolved` — pattern is ambiguous or cannot be resolved without bash; report explicitly and continue without it. Do not silently discard.
   - `invalid` — clearly malformed; report and exclude.
4. **Report status**: list every detected reference and its classification to the user before continuing.
5. **Continue with the resolved subset**: do not block the workflow on unresolved or invalid references. Surface them as residual risk (D-004).

If bash-style probing is required for a reference and is not available, classify it as `unresolved` rather than failing closed.

## Workflow (FR-022, FR-023)

After preflight completes:

1. Restate the objective and create or update a kanban item.
2. Inspect the repository or provided docs only as much as needed.
3. Use `feature-triager` when structured clarification would materially help.
4. Use `graph-impact-analyst` when existing code or integration boundaries matter.
5. Produce the **Mandatory First Response Format** with `## What I Understand / Что я понял`, `## What's Ambiguous / Что неоднозначно`, and `## Blocking Questions / Блокирующие вопросы` sections.
6. Ask focused follow-up questions in small batches.
7. Write `docs/specs/<slug>.md` only after the interview is sufficiently complete.

## Escalation to /spec (FR-023, EC-10, AC-07)

If at any point the request turns out to be ambiguous, high-risk, broad in scope, involves external integrations, or otherwise exceeds lightweight scope, explicitly recommend escalating to `/spec`. Suggested phrasing:

```text
## Escalation recommendation

This request exceeds /spec-lite scope. Recommend running:

  /spec <same free-text request>
```

Stop and wait for user confirmation before continuing as a lightweight spec.

## On the first ambiguous turn

Return the mandatory first-response structure with `## What I Understand / Что я понял`, `## What's Ambiguous / Что неоднозначно`, and `## Blocking Questions / Блокирующие вопросы`. Do not write `docs/specs/<slug>.md` in the first response.
