---
name: feature-interrogation
description: "Structured requirement clarification through focused questioning. Turns raw requests into engineering-ready task frames by externalizing hidden knowledge and resolving ambiguity."
---

# Feature Interrogation

Transform underspecified feature requests into complete task frames through disciplined questioning.

## Triggers

| Trigger | Description |
|---------|-------------|
| Raw feature request needs clarification | Initial request is vague or incomplete |
| Ambiguity map is large | Many unknown dimensions to resolve |
| After repo reconnaissance | Repository evidence gathered, gaps identified |
| Before design or spec finalization | Need complete requirement picture |
| User responds to initial blocking questions | Follow-up needed |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Restate objective precisely | Known facts and unknowns |
| 2 | Define scope, non-goals, assumptions | Scope boundaries |
| 3 | Question in themed batches | Questions with consequence framing |
| 4 | Classify risk | Risk class (low/medium/high) |
| 5 | Produce provisional acceptance criteria | AC list |
| 6 | Record clarification history | questions-log.md, decision-log.md |
| 7 | Declare readiness | Ready for design/implementation |

## Question Priority Tiers

### Tier 1: Blocking Questions (Must resolve before spec finalization)

| # | Category | Key Aspects |
|---|----------|-------------|
| 1 | Scope boundaries | What's in, what's out, what's deferred |
| 2 | Actors and permissions | Who can do what, role-based behavior |
| 3 | Core behavior | Step-by-step flow, triggers, preconditions |

### Tier 2: Critical Clarifications (Must resolve before implementation)

| # | Category | Key Aspects |
|---|----------|-------------|
| 4 | Data and validation | Required fields, formats, constraints |
| 5 | Failure handling | Error behavior, retry logic, rollback |
| 6 | Edge cases | Empty state, duplicates, conflicts, stale data |

### Tier 3: Important Context (Should resolve before implementation)

| # | Category | Key Aspects |
|---|----------|-------------|
| 7 | Contracts and compatibility | API changes, breaking changes, migration |
| 8 | Security and access control | AuthN/AuthZ, tenant isolation, audit |
| 9 | Observability | Logs, metrics, traces, alerts |

### Tier 4: Operational Details (Can resolve during implementation)

| # | Category | Key Aspects |
|---|----------|-------------|
| 10 | Rollout and migration | Feature flags, staged rollout, data migration |
| 11 | Testing and acceptance | Test strategy, acceptance criteria |

## Mandatory Question Categories

### A. Problem Framing

- What pain or limitation is being solved
- Who experiences it
- What success looks like
- What failure of the solution would look like

### B. Scope Boundaries

- What is definitely in scope
- What is definitely out of scope
- What adjacent requests are intentionally deferred

### C. Actors and Permissions

- Who triggers the behavior
- Who can observe the result
- Who can edit/cancel/retry
- How roles or ownership change behavior

### D. Behavior

- Step-by-step expected flow
- Triggers and preconditions
- Sync vs async behavior
- User-visible states before, during, and after the action

### E. Data and Validation

- Required and optional fields
- Format and range restrictions
- Uniqueness and deduplication rules
- Cross-field or domain validation

### F. Failure Handling

- What happens on error
- Whether retry is allowed
- Whether partial success is possible
- Whether rollback is needed
- What the user should see

### G. Compatibility and Rollout

- Whether old data/clients must remain supported
- Whether migration is required
- Whether feature flags are needed
- Whether staged rollout is desired

### H. Acceptance

- How the requester will decide the work is done
- What concrete observable outcomes must hold

## Questioning Strategy

Work in themed batches. Do not ask random isolated questions.

### How to Ask Better Questions

Prefer questions with **consequence framing**:

- **Bad**: "How should this work?"
- **Good**: "If the same operation is submitted twice after a network retry, should the system create a duplicate, return the original result, or fail with a conflict? This determines idempotency and duplicate prevention behavior."

### Question Framing Template

```
[Scenario description]

Options:
A. [Option 1] - [Consequence]
B. [Option 2] - [Consequence]
C. [Option 3] - [Consequence]

This affects: [Impact areas]
```

## Post-Answer Processing

After each answer batch:

| Step | Action |
|------|--------|
| 1 | Restate confirmed decisions clearly |
| 2 | Update provisional feature model |
| 3 | Record in questions-log.md and decision-log.md |
| 4 | Identify new ambiguities introduced by answers |
| 5 | Prepare next question batch or declare readiness |

## Decision Recording

### questions-log.md format

```markdown
## Question Q-001

**Category**: scope | actors | behavior | data | validation | failure | compatibility | acceptance
**Why it matters**: Impact on implementation or user experience
**Question**: Concrete question with consequence framing
**Answer**: User's response
**Resolution status**: open | partially resolved | resolved
**Date**: YYYY-MM-DD
```

### decision-log.md format

```markdown
## Decision D-001

**Status**: accepted | proposed | superseded | rejected
**Date**: YYYY-MM-DD
**Decision**: Clear statement of what was decided
**Rationale**: Why this choice was made
**Alternatives considered**: What was rejected and why
**Consequences**: Downstream impact and trade-offs
```

## Delegation Patterns

| User Says | Response |
|-----------|----------|
| "Make it reasonable" | Convert to explicit decision with rationale |
| "As usual" | Tie to concrete existing behavior from repository |
| "I don't know" | Mark as assumption, note impact if false |
| "Whatever works" | Propose default with rationale, get confirmation |

## Human-Facing Output Convention

Use bilingual labels when presenting question batches:

- `What I understand / Что я понял`
- `Ambiguities / Неоднозначности`
- `Blocking questions / Блокирующие вопросы`
- `Important clarifications / Важные уточнения`
- `Suggested defaults / Предлагаемые значения по умолчанию`

Core internal instructions remain English-only.

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not write code |
| 2 | Do not design implementation beyond scope and risk needs |
| 3 | If request is under-specified, make that explicit instead of guessing |
| 4 | If unknowns block implementation, say so explicitly with questions |
| 5 | Do not accept "make it reasonable" unless converted to explicit decision |
| 6 | Do not accept "as usual" unless tied to concrete existing behavior |
| 7 | If user answers partially, mark question as partially resolved |
| 8 | If response introduces new ambiguity, create follow-up questions |
| 9 | Do not stop at happy-path clarification |
| 10 | Do not finalize requirements without explicit acceptance criteria |

## Output Contract

Return:

| Field | Description |
|-------|-------------|
| objective | What the feature aims to achieve |
| known_facts | Verified from repo or user answers |
| scope_and_non_goals | What's in and out of scope |
| assumptions | Temporary assumptions with impact notes |
| blocking_unknowns | Questions preventing finalization |
| questions_for_user | Next batch with consequence framing |
| risk_class | Low, medium, or high |
| acceptance_criteria | Provisional verifiable criteria |
| ready_for_design | Boolean |
| ready_for_implementation | Boolean |
| recommended_next_step | What to do next |
| clarification_rounds_completed | Count of rounds so far |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Random isolated questions | Disorganized, misses connections | Work in themed batches |
| Vague questions | Low response quality | Consequence framing |
| Acceptance of "reasonable" without decision | Ambiguity persists | Convert to explicit decision |
| Stopping at happy path | Misses failure modes | Continue to edge cases, errors |
| Over-questioning implementation trivia | Wastes rounds | Focus on product behavior and scope |
| Finalizing without acceptance criteria | No completion standard | Define observable success conditions |

## Verification Checklist

- [ ] Scope boundaries clearly defined (in/out/deferred)
- [ ] Actors and permissions identified for each operation
- [ ] Core behavior described with step-by-step flow
- [ ] Failure handling specified for each operation
- [ ] Edge cases enumerated with expected behavior
- [ ] Compatibility and rollout requirements captured
- [ ] Acceptance criteria defined and verifiable
- [ ] Questions use consequence framing (not vague)
- [ ] Risk classified and documented
- [ ] All decisions recorded in decision-log.md
- [ ] Clarification history in questions-log.md
- [ ] No unresolved ambiguities remain before declaring ready
