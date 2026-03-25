---
name: edge-case-harvester
description: >
  Systematically enumerates edge cases, negative scenarios, conflict states,
  and degradation modes so the final specification is resilient beyond the happy path.
---

# Purpose

Prevent implementation failure on conditions that were not covered by the happy path.

# Working Principle

For every important feature action, ask:
- what if the input is empty,
- what if the input is invalid,
- what if the action is repeated,
- what if the state changed concurrently,
- what if permissions are insufficient,
- what if a dependency fails,
- what if only part of the work succeeds,
- what if the data is old or inconsistent,
- what if limits are hit,
- what if legacy data is involved.

# Required Edge-Case Classes

You must examine these classes unless clearly not applicable:

1. Empty or missing input/state
2. Invalid or malformed input
3. Duplicate or replayed action
4. Conflict or concurrent update
5. Permission or ownership mismatch
6. Stale or outdated client state
7. Partial failure
8. Dependency failure
9. Timeout and retry behavior
10. Large volume, paging, or limits
11. Migration and legacy data behavior
12. Observability blind spots

# Method

For each key operation:
1. identify the normal behavior;
2. enumerate realistic abnormal conditions;
3. define expected system behavior;
4. define expected user-visible behavior;
5. define logging/metrics implications;
6. define test implications.

# Required Output Shape

For each edge case, capture:
- Case
- Why it matters
- Trigger condition
- Expected system behavior
- Expected user-visible behavior
- Logging / metrics implications
- Testing implications

# Where to Record Results

Edge-case findings should be reflected in:
- `spec.md` under `Edge cases and failure handling`,
- `questions-log.md` when clarification is required,
- `decision-log.md` when a behavior choice is confirmed,
- `traceability.md` when mapped to tests and acceptance.

# Commonly Missed Cases

Do not forget:
- double-click / double-submit,
- retries after uncertain success,
- stale form data,
- deleted or changed related objects,
- role changes mid-session,
- partial persistence success,
- invalid old drafts or legacy entities,
- pagination boundaries,
- race conditions with background jobs,
- eventual consistency gaps,
- duplicate external callbacks or webhooks.

# Hard Rules

1. Do not reduce edge cases to form validation only.
2. Consider product, domain, and infrastructure failure modes.
3. If no expected behavior is defined for an important edge case, the spec is incomplete.
4. If the repository already encodes some edge-case behavior, distinguish it from new required behavior.
