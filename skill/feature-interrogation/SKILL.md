---
name: feature-interrogation
description: >
  Conducts structured requirement clarification. Extracts hidden expectations,
  product rules, edge-case behavior, and acceptance criteria from the requester.
---

# Purpose

Reduce ambiguity until the feature can be specified without guesswork.

# Core Principle

The requester almost always knows more than they initially wrote.
Your job is to externalize that knowledge.

Do not settle for approximate understanding when exact understanding is possible.

# Logging Requirement

Every clarification round must be recorded in the current task workspace:

`specs/<task-id>/questions-log.md`

Record:
- question category,
- why the question matters,
- the exact question,
- the user's answer,
- resolution status.

If a user response confirms a product choice, also ensure it is captured in `decision-log.md`.

# Questioning Strategy

Do not ask random isolated questions.
Work in themed batches.

Recommended order:
1. problem framing,
2. scope boundaries,
3. actors and permissions,
4. user-visible behavior,
5. data and validation,
6. edge cases and failure handling,
7. compatibility and rollout,
8. testing and acceptance.

# Mandatory Question Categories

## A. Problem Framing
Clarify:
- what pain or limitation is being solved,
- who experiences it,
- what success looks like,
- what failure of the solution would look like.

## B. Scope Boundaries
Clarify:
- what is definitely in scope,
- what is definitely out of scope,
- what adjacent requests are intentionally deferred.

## C. Actors and Permissions
Clarify:
- who triggers the behavior,
- who can observe the result,
- who can edit/cancel/retry,
- how roles or ownership change behavior.

## D. Behavior
Clarify:
- step-by-step expected flow,
- triggers and preconditions,
- sync vs async behavior,
- user-visible states before, during, and after the action.

## E. Data and Validation
Clarify:
- required and optional fields,
- format and range restrictions,
- uniqueness and deduplication rules,
- cross-field or domain validation.

## F. Failure Handling
Clarify:
- what happens on error,
- whether retry is allowed,
- whether partial success is possible,
- whether rollback is needed,
- what the user should see.

## G. Compatibility and Rollout
Clarify:
- whether old data/clients must remain supported,
- whether migration is required,
- whether feature flags are needed,
- whether staged rollout is desired.

## H. Acceptance
Clarify:
- how the requester will decide the work is done,
- what concrete observable outcomes must hold.

# How to Ask Better Questions

Prefer questions with consequence framing.

Weak:
- "How should this work?"

Strong:
- "If the same operation is submitted twice after a network retry, should the system create a duplicate, return the original result, or fail with a conflict? This determines idempotency and duplicate prevention behavior."

Weak:
- "Any edge cases?"

Strong:
- "If the related object is deleted while the user still has the form open, should submit fail, prompt for refresh, or attempt repair? This affects stale-state handling."

# Human-Facing Output Convention

When presenting question batches to humans, bilingual labels are allowed:
- `What I understand / Что я понял`
- `Ambiguities / Неоднозначности`
- `Blocking questions / Блокирующие вопросы`
- `Important clarifications / Важные уточнения`
- `Suggested defaults / Предлагаемые значения по умолчанию`

Core internal instructions remain English-only.

# Post-Answer Processing

After each answer batch:
1. restate confirmed decisions;
2. list remaining ambiguities;
3. propose defaults where the user delegated the choice;
4. update the provisional feature model;
5. update:
   - `questions-log.md`,
   - `decision-log.md`,
   - `assumptions.md` if any temporary assumptions remain.

# Hard Rules

1. Do not accept "make it reasonable" as sufficiently specified unless you convert it into an explicit decision.
2. Do not accept "as usual" unless you tie it to a concrete existing behavior in the repository.
3. If the user answers partially, mark the question as partially resolved.
4. If a response introduces new ambiguity, create follow-up questions.
5. Do not stop at happy-path clarification.
6. Do not finalize requirements without explicit acceptance criteria.