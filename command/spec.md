---
description: Comprehensive specification discovery for complex features — interview, analyze, and produce an implementation-ready spec
agent: full-spec-analyst
---

<!-- markdownlint-disable MD041 -->

# /spec — Comprehensive Specification Discovery

Route this command to the `full-spec-analyst` agent with `$ARGUMENTS` as the user input.

## Inputs

- `$ARGUMENTS` — Free-text feature or change request. May contain a ticket pattern (e.g. `EVODP-1234`) and zero or more path-like or repo-like references.

## Empty-Input Guard (EC-01, VR-01, D-017)

If `$ARGUMENTS` is empty or whitespace-only, do not start the workflow. Return this usage message and stop:

```text
Usage: /spec <feature or change request>

Provide a short description of the feature or change you want specified.
Examples:
  /spec EVODP-1234 add user profile export to PDF
  /spec new billing webhook handler with retry and DLQ
  /spec refactor auth middleware to support multi-tenant tokens
```

## Task-ID Derivation (D-009)

Derive the task ID from `$ARGUMENTS` using this priority order:

1. **Ticket pattern**: if `$ARGUMENTS` contains a token matching `[A-Z][A-Z0-9]+-\d+` (e.g. `EVODP-1234`), use it as the task ID.
2. **Slug fallback**: if no ticket pattern is present, take the first 4–6 meaningful words, lowercase, and join with `-` to form a kebab-case slug. Strip filler words (`a`, `the`, `and`, `for`, `to`, `of`, `in`, `on`).
3. **Collision avoidance**: if `docs/specs/<task-id>/` already exists, append `-1`, `-2`, ... until a free directory is found.

The spec workspace is `docs/specs/<task-id>/`.

## Early Permission Preflight (FR-011 to FR-017, D-004, D-012, EC-05)

Before the main discovery workflow, run a best-effort permission preflight on every path-like or repo-like reference detected in `$ARGUMENTS`:

1. **Detect references**: extract tokens that look like absolute paths, relative paths, `~/`-prefixed paths, `file://` URIs, or `org/repo` style GitHub references. Deduplicate the list (EC-05).
2. **Probe each path**: attempt access using `read`, `glob`, or `grep` tools (whichever the agent's permission matrix allows).
3. **Classify each reference** as one of:
   - `in-workspace` — inside the current working directory tree.
   - `allowed-external` — outside the workspace but the agent already has explicit `read`/`glob` permission for that path.
   - `needs-approval` — the agent does not yet have access; surface this to the user and pause for approval before continuing.
   - `unresolved` — the path syntax is ambiguous or cannot be resolved; report it explicitly to the user. Do not silently drop it.
   - `invalid` — the path is clearly malformed; report and exclude.
4. **Report status**: list every detected reference and its classification to the user before continuing.
5. **Continue with the resolved subset**: if some references are unresolved or invalid, do not block the whole workflow. Continue with the references that were successfully classified, and surface the rest as residual risk (D-004).
6. **Front-load approvals**: prefer requesting access to all detected external paths at the start of the workflow, even if it surfaces multiple prompts (D-012). Later approval requests remain allowed when new necessary paths are discovered.

## Workflow

After preflight completes:

1. Inspect the repository context, referenced docs, and any successfully probed external paths.
2. Ask blocking questions in focused batches (FR-019). Propose defaults when useful. Do not write a placeholder design doc with unresolved questions.
3. **Summarize understanding in Russian and wait for explicit user approval before final spec creation** (FR-020, AC-06). Use a structure similar to:

   ```text
   ## Что я понял

   [Краткое изложение задачи и согласованных требований на русском языке]

   ## Открытые вопросы

   [Список оставшихся неоднозначностей, требующих ответа]

   ## Следующий шаг

   [План создания spec.md после подтверждения]
   ```

4. Delegate specialized analysis to `repo-scout`, `feature-triager`, `design-planner`, `edge-case-harvester`, `contract-impact-auditor`, `non-functional-prober`, and `traceability-checker` as needed.
5. Write the final handoff-ready spec to `docs/specs/<task-id>/spec.md` only after the questioning loop is complete and the Russian understanding summary is approved.
6. Do not implement code. Stop when the spec is ready for `dev-orchestrator` (via `/execute-spec`) or when more user answers are required.

## On the first ambiguous turn

Return a discovery summary and ask blocking questions. Do not scaffold code or create product files.
