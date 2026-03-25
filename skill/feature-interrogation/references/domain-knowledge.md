# Feature Interrogation Domain Knowledge

## Question Categories and Priority

### Tier 1: Blocking Questions (Must resolve before spec finalization)

1. **Scope boundaries**: What's in, what's out, what's deferred
2. **Actors and permissions**: Who can do what, role-based behavior
3. **Core behavior**: Step-by-step flow, triggers, preconditions

### Tier 2: Critical Clarifications (Must resolve before implementation)

4. **Data and validation**: Required fields, formats, constraints
5. **Failure handling**: Error behavior, retry logic, rollback
6. **Edge cases**: Empty state, duplicates, conflicts, stale data

### Tier 3: Important Context (Should resolve before implementation)

7. **Contracts and compatibility**: API changes, breaking changes, migration
8. **Security and access control**: AuthN/AuthZ, tenant isolation, audit
9. **Observability**: Logs, metrics, traces, alerts

### Tier 4: Operational Details (Can resolve during implementation)

10. **Rollout and migration**: Feature flags, staged rollout, data migration
11. **Testing and acceptance**: Test strategy, acceptance criteria

## Question Quality Framework

### Bad Questions (Avoid)

- "Can you clarify requirements?" (too vague)
- "Any edge cases?" (no framing)
- "How should this work?" (no options)
- "What about errors?" (no specificity)

### Good Questions (Use)

- "If the user resubmits after success, should the system create a duplicate, return the existing object, or fail with a conflict? This affects idempotency and API semantics."
- "If the related object is deleted while the form is open, should submit fail, prompt for refresh, or attempt repair? This affects stale-state handling."
- "Should validation happen client-side only, server-side only, or both? This affects UX responsiveness and security guarantees."

## Question Framing Template

```
[Scenario description]

Options:
A. [Option 1] - [Consequence]
B. [Option 2] - [Consequence]
C. [Option 3] - [Consequence]

This affects: [Impact areas]
```

## Interrogation Flow

1. **Problem framing** (1 round)
   - Understand the pain point
   - Clarify success criteria
   - Identify affected users

2. **Scope and actors** (1-2 rounds)
   - Define boundaries
   - Map roles and permissions
   - Identify integration points

3. **Behavior and data** (2-3 rounds)
   - Detail happy path
   - Define validation rules
   - Specify data model

4. **Edge cases and failures** (1-2 rounds)
   - Enumerate abnormal conditions
   - Define failure behavior
   - Specify recovery paths

5. **Compatibility and rollout** (1 round)
   - Address breaking changes
   - Plan migration
   - Define observability

## Answer Processing

After each answer batch:

1. **Restate** confirmed decisions clearly
2. **Update** provisional feature model
3. **Record** in questions-log.md and decision-log.md
4. **Identify** new ambiguities introduced by answers
5. **Prepare** next question batch

## Delegation Patterns

When user says:
- "Make it reasonable" → Convert to explicit decision with rationale
- "As usual" → Tie to concrete existing behavior from repo-scout.md
- "I don't know" → Mark as assumption, note impact if false
- "Whatever works" → Propose default with rationale, get confirmation

## Anti-Patterns

- ❌ Accepting vague answers as sufficient
- ❌ Stopping at happy-path clarification
- ❌ Asking all questions in one overwhelming batch
- ❌ Not recording partial answers
- ❌ Finalizing spec with unresolved blocking questions
