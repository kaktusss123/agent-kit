---
description: Execute an approved specification through the dev-orchestrator engineering workflow
agent: dev-orchestrator
---

<!-- markdownlint-disable MD041 -->

# /execute-spec — Execute an Approved Specification

Route this command to the `dev-orchestrator` agent with `$ARGUMENTS` as the user input.

## Inputs

- `$ARGUMENTS` — Must contain an explicit spec reference. Accepted forms (D-014, VR-02):
  - A path to a spec workspace folder, e.g. `docs/specs/EVODP-1234/`.
  - A path to a `spec.md` file, e.g. `docs/specs/EVODP-1234/spec.md`.
  - A task-id or workspace identifier, e.g. `EVODP-1234` or `docs/specs/EVODP-1234`.

## Empty-Input Guard (EC-03, VR-01, D-017)

If `$ARGUMENTS` is empty or whitespace-only, do not start the workflow. Return this usage message and stop:

```text
Usage: /execute-spec <spec reference>

Provide one of:
  - a spec workspace folder path (e.g. docs/specs/EVODP-1234/)
  - a spec.md file path (e.g. docs/specs/EVODP-1234/spec.md)
  - a task-id or workspace identifier (e.g. EVODP-1234)
```

## Explicit Spec-Reference Requirement (FR-009, VR-02, D-014)

If `$ARGUMENTS` does not contain at least one explicit spec reference in one of the accepted forms, do not guess from recency or chat state. Return a usage message explaining the accepted reference forms and stop.

Examples of input that DO NOT satisfy the requirement:

- A free-text feature description with no path or task-id.
- A vague pointer such as "the latest spec" or "the auth spec".
- A kanban item reference without a path or task-id.

## Early Permission Preflight (FR-011 to FR-017, D-004, D-012, EC-05)

Before the spec-validation phase, run a best-effort permission preflight on every path-like or repo-like reference detected in `$ARGUMENTS` (including the spec reference itself):

1. **Detect references**: extract absolute paths, relative paths, `~/`-prefixed paths, and `org/repo` style references from `$ARGUMENTS`. Deduplicate the list (EC-05).
2. **Probe each path**: attempt access using `read`, `glob`, or `grep` tools.
3. **Classify each reference** as `in-workspace`, `allowed-external`, `needs-approval`, `unresolved`, or `invalid`.
4. **Report status**: list every detected reference and its classification to the user before continuing.
5. **Continue with the resolved subset**: do not block the workflow on unresolved references (D-004). Surface unresolved references explicitly (AC-11).
6. **Front-load approvals**: prefer requesting access to all detected external paths at the start of the workflow, even if it surfaces multiple prompts (D-012).

## Spec-Validation-First Phase (FR-024 to FR-028, OB-03, AC-08)

Before any implementation work, treat the referenced spec as an input artifact, not as unquestioned truth. The first phase of the workflow is validation:

1. **Read spec artifacts**: read every file in the referenced spec workspace (`spec.md`, `decision-log.md`, `questions-log.md`, `assumptions.md`, `repo-scout.md`, `traceability.md`, and any other referenced artifacts).
2. **Compare against current repository facts**: cross-check the spec's claims about the repository, the existing components, and the integration points against the actual current state of the code. Use `repo-scout` when the gap is large.
3. **Identify contradictions or missing decisions**:
   - Are any acceptance criteria untestable as written?
   - Do any decisions conflict with each other or with current repository facts?
   - Are there material gaps in permissions, error handling, edge cases, or rollback?
   - Are referenced files, modules, or APIs actually present and behaving as described?
4. **Stop for clarifications if material gaps remain**: do NOT skip to implementation when the spec is incomplete, contradictory, or lacks testable acceptance criteria. Surface the gaps to the user in chat, list the missing decisions, and wait for resolution.
5. **Report validation result explicitly (OB-03)**: state one of:
   - `passed validation` — spec is consistent with repository facts, all acceptance criteria are testable, no material gaps.
   - `failed validation` — spec has contradictions or unfixable gaps; stop and request updates.
   - `requires more user input` — spec is incomplete in a way that the user must resolve; stop and list the open questions.

## Continuing Through the Normal Workflow (FR-028)

After spec validation passes:

1. Continue through the standard `dev-orchestrator` workflow: create or update the kanban item, delegate triage to `feature-triager`, dispatch `repo-scout` and `design-planner` as needed, and only then dispatch `implementer` for code changes.
2. Follow the `implement -> commit -> verify/review` invariant against the resulting commit hash.
3. Select the R0–R4 review tier and dispatch domain reviewers against that commit.
4. Stop and await user approval after the latest implementation commit has no remaining defects.

Do not bypass the spec-validation phase even if the user appears impatient or the spec is well-known.
