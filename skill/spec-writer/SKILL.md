---
name: spec-writer
description: >
  Produces the final implementation-ready specification from repository findings,
  clarified requirements, captured decisions, assumptions, and coverage checks.
---

# Purpose

Convert the collected understanding into an implementation-ready specification.

# Required Inputs

The spec must be derived from the current task workspace, including:
- `repo-scout.md`
- `questions-log.md`
- `decision-log.md`
- `assumptions.md`
- `traceability.md` if already available

# Writing Principles

1. Write precisely and operationally.
2. Avoid vague statements like:
   - "should work smoothly"
   - "handle errors properly"
   - "support all cases"
3. Every important requirement must be testable or observable.
4. Separate:
   - current state,
   - target state,
   - migration bridge between them.
5. Distinguish:
   - confirmed decisions,
   - open questions,
   - assumptions,
   - proposed defaults.

# Consistency Rules

1. Do not present inferred behavior as confirmed if it only exists in assumptions.
2. Decisions in `decision-log.md` must be reflected in `spec.md`.
3. Open questions in `questions-log.md` must either:
   - remain in `Open questions`,
   - or be resolved and mapped into requirements.
4. Temporary assumptions must appear in the `Assumptions` section.
5. Repository facts should be consistent with `repo-scout.md`.

# Required Spec Structure

The final `spec.md` must contain:

## 1. Title
Clear task title.

## 2. Summary
A concise description of the change in a few paragraphs.

## 3. Problem / Motivation
Why the change is needed and what pain it solves.

## 4. Goals
Concrete outcomes the feature must achieve.

## 5. Non-goals
Adjacent changes explicitly excluded.

## 6. Current state
Relevant current behavior and system context.

## 7. Scope
In-scope and out-of-scope boundaries.

## 8. Actors / Roles
Relevant users, systems, and permissions context.

## 9. Domain model
Entities, fields, relationships, and invariants.

## 10. Scenarios
Happy path, alternate paths, failure paths, recovery paths.

## 11. Functional requirements
Numbered requirements such as `FR-1`, `FR-2`, etc.

## 12. Business rules
Domain constraints and invariants such as `BR-1`, `BR-2`.

## 13. Validation rules
Input and domain validation rules such as `VR-1`, `VR-2`.

## 14. Edge cases and failure handling
Concrete behaviors for abnormal conditions.

## 15. API / interfaces / contracts
Requests, responses, events, payloads, compatibility notes.

## 16. Data model and persistence impact
Schema changes, migration needs, data handling, indexing, legacy compatibility.

## 17. Security / permissions
Authn/authz, ownership, tenant isolation, audit implications.

## 18. Observability
Logs, metrics, traces, dashboards, alerting signals.

## 19. Rollout / migration / backward compatibility
Flags, staged rollout, migration order, rollback considerations.

## 20. Testing strategy
Unit, integration, contract, E2E, regression coverage.

## 21. Acceptance criteria
Checklist or numbered criteria such as `AC-1`, `AC-2`, etc.

## 22. Open questions
Anything still unresolved.

## 23. Assumptions
Temporary or explicit assumptions that affect the spec.

## 24. Appendix
Examples, pseudo-sequences, sample payloads, state diagrams if useful.

# Human-Facing Output Convention

If a human-readable outline is shown, bilingual labels are allowed:
- `Summary / Резюме`
- `Goals / Цели`
- `Non-goals / Не цели`
- `Open questions / Открытые вопросы`
- `Assumptions / Допущения`
- `Acceptance criteria / Критерии приемки`

Core spec content remains English-only unless the user explicitly requests otherwise.

# Quality Checks Before Finalizing

Before marking the spec ready, verify:
1. each goal maps to concrete requirements;
2. each critical scenario has defined behavior;
3. permissions are specified;
4. edge cases are not omitted;
5. compatibility impact is addressed;
6. observability is not vague;
7. acceptance criteria are checkable;
8. unresolved assumptions are explicit.

# Hard Rules

1. Every section must contain either concrete content or `N/A` with explanation.
2. Do not hide major risks in the appendix.
3. If a requirement cannot be tested or observed, rewrite it.
4. If a decision has not been made, do not mask it as settled.
