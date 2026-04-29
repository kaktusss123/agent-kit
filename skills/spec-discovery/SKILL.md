---
name: spec-discovery
description: "Systematic specification discovery for complex and ambiguous features. Removes ambiguity through structured analysis until an implementation-ready spec or documented blockers exist."
---

# Spec Discovery

Systematically discover and clarify feature requirements through workspace-based discovery, structured questioning, and specialized subagent delegation.

## Triggers

| Trigger | Description |
|---------|-------------|
| Complex features with significant ambiguity | Multiple unknown dimensions requiring investigation |
| Greenfield product work | No existing implementation to reference |
| Features with external integration dependencies | Multiple system boundaries affected |
| High-risk changes | Changes affecting multiple systems or teams |
| User explicitly requests full specification discovery | "Spec this out", "full spec", "discovery" |

## Quick Reference

| Phase | Action | Artifact |
|-------|--------|----------|
| 1 | Restate task in structured form | First response |
| 2 | Initialize/locate task workspace | `docs/specs/<task-id>/` |
| 3 | Create kanban item | Kanban task |
| 4 | Ask first blocking questions | `questions-log.md` |
| 5 | Delegate repo reconnaissance | `repo-scout.md` |
| 6 | Delegate structured clarification | `questions-log.md`, `decision-log.md` |
| 7 | Delegate specialized analysis | Per-subagent artifacts |
| 8 | Synthesize evidence into spec | `spec.md` |
| 9 | Verify completeness | `traceability.md` |
| 10 | Declare outcome | One of three verdicts |

## Workflow

### 10-Step Workflow

1. **Restate the task** in structured form (see Mandatory First Response Format).
2. **Initialize or locate the task workspace** using `task-workspace` skill. Path: `docs/specs/<task-id>/`.
3. **Create or locate a kanban item** for the specification task using `kanban-discipline` skill.
4. **Ask the first batch of blocking questions** before deep synthesis.
5. **After initial clarification**, delegate repository reconnaissance to `repo-scout`.
6. **Delegate structured clarification** to `feature-triager` when the ambiguity map is large enough.
7. **Delegate specialized analysis** as needed:
   - `edge-case-harvester`
   - `contract-impact-auditor`
   - `non-functional-prober`
   - `design-planner` (when trade-offs or planning notes belong in the spec package)
8. **Synthesize the resulting evidence** into `spec.md`.
9. **Delegate completeness verification** to `traceability-checker`.
10. **Stop** with one of these outcomes:
    - `needs_answers`
    - `spec_ready`
    - `blocked_external_dependency`

### Mandatory First Response Format

The FIRST response to any specification request MUST follow this structure:

```text
## Current State Analysis / Анализ текущего состояния

[What exists now: repository state, provided docs, known system behavior]

## Target State Analysis / Анализ целевого состояния

[What the requester wants to achieve]

## What I Understand / Что я понял

[Confirmed facts and clear requirements]

## Ambiguities / Неоднозначности

[Unclear or underspecified areas]

## Blocking Questions / Блокирующие вопросы

[3-7 highest-priority questions with consequence framing]
```

Do not skip this format. Do not write `spec.md` in the first response. Do not delegate to subagents in the first response.

## Discovery Rules

| Rule | Description |
|------|-------------|
| Questions before final spec | Never write the final spec before clarifying unknowns |
| Ask about product, not implementation | Product behavior, contracts, permissions, edge cases, failure modes |
| Batch questions | Ask in small, focused batches |
| Repository over questioning | If the repo answers reliably, do not ask the user |
| Wait for answers | If user hasn't answered, stop and wait |
| No silent inventions | Never silently invent product decisions |

### Mandatory Question Categories

Cover these categories for every feature unless clearly not applicable:

| # | Category |
|---|----------|
| 1 | Scope boundaries |
| 2 | Actors and permissions |
| 3 | User-visible behavior |
| 4 | Domain/data rules |
| 5 | Validation rules |
| 6 | Edge cases |
| 7 | Failure handling |
| 8 | Contracts and compatibility |
| 9 | Security and access control |
| 10 | Observability |
| 11 | Rollout/migration |
| 12 | Testing and acceptance criteria |

### Mandatory Coverage Expectations

For every meaningful feature, the final spec must cover:

| Coverage Area | Description |
|---------------|-------------|
| Happy path | Primary successful flow |
| Alternate paths | Valid but different user journeys |
| Failure paths | Expected error conditions and handling |
| Recovery paths | How system returns to valid state after failure |
| Invalid input | Malformed or out-of-range input |
| Empty input/state | Missing data scenarios |
| Duplicate/retry | Replayed or repeated actions |
| Permission denial | Unauthorized access attempts |
| Partial failure | Some operations succeed, others fail |
| Timeout/dependency failure | External system unavailability |
| Backward compatibility | Old clients and data still work |
| Migration/rollout | Path from current to new state |
| Observability | Logs, metrics, traces, alerts |
| Testing strategy | How to verify correctness |

## Question Batch Format (Human-Facing)

When presenting question batches:

```text
What I understand / Что я понял
Ambiguities / Неоднозначности
Blocking questions / Блокирующие вопросы
Important clarifications / Важные уточнения
Suggested defaults / Предлагаемые значения по умолчанию
```

Prefer concrete questions with consequence framing:

- "If the user resubmits the same form after a successful create, should the system create a duplicate, return the existing object, or fail with a conflict? This affects idempotency, user feedback, and API semantics."

Do not ask vague questions like "Can you clarify requirements?"

## Output Contract

Always return:
1. current stage
2. what is known
3. blocking questions or readiness verdict
4. workspace path
5. next recommended action

### Workspace Artifacts

| File | Purpose |
|------|---------|
| `spec.md` | Implementation-ready specification |
| `decision-log.md` | Explicit decisions and rationale |
| `questions-log.md` | Clarification history |
| `repo-scout.md` | Repository reconnaissance |
| `assumptions.md` | Unresolved temporary assumptions |
| `traceability.md` | Coverage and completeness results |
| `design-brief.md` | Design options and trade-offs (optional) |
| `execution-plan.md` | Implementation steps (optional) |

### Outcome States

| Outcome | Meaning |
|---------|---------|
| `needs_answers` | Blocked on user responses to open questions |
| `spec_ready` | Implementation-ready spec complete |
| `blocked_external_dependency` | External dependency required before spec can proceed |

## Source of Truth Policy

| Source | Role |
|--------|------|
| `spec.md` | Current implementation-ready spec |
| `decision-log.md` | Explicit decisions and rationale |
| `questions-log.md` | Clarification history |
| `assumptions.md` | Unresolved temporary assumptions |
| `repo-scout.md` | Repository reconnaissance |
| `traceability.md` | Coverage and completeness |

Conflict resolution order:
1. Explicit accepted decisions override unstructured notes
2. Confirmed user answers override agent inference
3. Unresolved contradictions must be surfaced, not hidden

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Writing spec before clarifying unknowns | Produces speculative content, wastes rework | Ask blocking questions first |
| Asking implementation trivia | Misses product-level ambiguity | Ask about behavior, permissions, failure modes |
| One-shot all questions | Overwhelms requester, low response quality | Batch in small focused groups |
| Asking what repo can answer | Wastes user time | Read the repository first |
| Silently filling gaps with assumptions | Creates incorrect specifications | Surface gaps explicitly as questions |
| Skipping coverage categories | Spec covers only happy path | Enumerate all mandatory categories |

## Verification Checklist

- [ ] First response followed mandatory format with bilingual sections
- [ ] All 12 mandatory question categories addressed (or explicitly N/A)
- [ ] All 14 coverage categories present in spec
- [ ] Each blocking question has consequence framing
- [ ] Task workspace initialized at `docs/specs/<task-id>/`
- [ ] Required subagents delegated as appropriate
- [ ] Outcome declared: needs_answers | spec_ready | blocked_external_dependency
- [ ] No implementation code written
- [ ] Traceability verified before declaring spec_ready
- [ ] Decision log populated with rationale
