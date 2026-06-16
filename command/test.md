---
description: Orchestrate test planning, implementation, and verification for Python projects
agent: tester
---

<!-- markdownlint-disable MD041 -->

# /test — Test Orchestration

Route this command to the `tester` agent with `$ARGUMENTS` as the user input.

## Inputs

- `$ARGUMENTS` — Free-text scope hints. May contain:
  - Mode hints: `diff-oriented`, `targeted`, `bootstrap-coverage`.
  - Target hints: a file path, a module path, a package path, or a pytest filter expression.
  - A free-text description of the test goal.

## Default Mode (FR-010, VR-06, D-018, AC-09)

If `$ARGUMENTS` is empty, contains no explicit scope, or is too vague to classify:

- Default to `diff-oriented` mode against current changes (`git diff develop...HEAD`, falling back to `origin/develop`, then to recorded fallback).
- State the default explicitly in the first response (OB-04), e.g.:

  ```text
  ## Selected mode

  /test invoked without explicit scope. Defaulting to **diff-oriented** mode against current changes.
  ```

This applies to:

- Empty `$ARGUMENTS`.
- Vague but non-empty `$ARGUMENTS` such as "improve tests" or "add coverage" (EC-14).

## Mode Inference (FR-030, OB-04)

When `$ARGUMENTS` is non-empty, infer the mode from the free text using the tester agent's documented modes:

- `diff-oriented` — phrases like "cover the diff", "current changes", "the feature I just added", "current branch", "what I changed".
- `targeted` — phrases naming a specific file, module, package, or subsystem, e.g. `tests/test_auth.py`, `src/billing/`, `pytest -k "idempotency"`.
- `bootstrap-coverage` — phrases like "raise coverage", "cover the project", "bootstrap tests", "reach 50%".

If multiple mode hints are present, prefer the most specific one. If mode inference fails, fall back to `diff-oriented` and state that default explicitly (EC-14).

State the inferred or selected mode explicitly in the first response (OB-04), e.g.:

```text
## Selected mode

Inferred **targeted** mode from "$ARGUMENTS".
Target: src/billing/webhook_handler.py
```

## Early Permission Preflight (FR-011 to FR-017, D-004, D-012, EC-05)

Before the main tester workflow, run a best-effort permission preflight on every path-like reference detected in `$ARGUMENTS`:

1. **Detect references**: extract absolute paths, relative paths, `~/`-prefixed paths, and pytest filter expressions that include file or module globs. Deduplicate the list (EC-05).
2. **Probe each path**: attempt access using `read`, `glob`, or `grep` tools.
3. **Classify each reference** as `in-workspace`, `allowed-external`, `needs-approval`, `unresolved`, or `invalid`.
4. **Report status**: list every detected reference and its classification to the user before continuing.
5. **Continue with the resolved subset**: surface unresolved references explicitly (AC-11); do not block the workflow on them.
6. **Front-load approvals**: prefer requesting access to all detected external paths at the start of the workflow (D-012).

The `tester` agent has `bash: deny` except for the documented allowlist, so preflight must not depend on bash. Use read/glob-based probing and classify ambiguous tokens as `unresolved`.

## Workflow (FR-031)

After mode selection and preflight:

1. Create a new run directory `docs/agent-testing/<run-id>/` and write `goal.md`.
2. Load the `testing-python` skill.
3. Collect baseline and coverage; do not proceed if the relevant baseline is red.
4. Determine scope from the selected mode.
5. Build planning capsules, dispatch `test_planner`, sanity-check plans, dispatch `test_writer` sequentially, and dispatch `test_reviewer` once.
6. Run final verification against the recorded regression sets and any user-defined invariants.
7. Write `docs/agent-testing/<run-id>/final-report.md` that cites baseline, coverage, sanity, writer, reviewer, and verification artifacts.

Do not skip the baseline or coverage collection steps, even when the user explicitly asked for a quick test run.
