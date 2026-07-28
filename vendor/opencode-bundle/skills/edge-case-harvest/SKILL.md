---
name: edge-case-harvest
description: "Systematically enumerates edge cases, negative scenarios, conflict states, and degradation modes so specifications are resilient beyond the happy path."
---

# Edge Case Harvest

Systematically enumerate edge cases and failure modes to ensure specifications are resilient beyond the happy path.

## Triggers

| Trigger | Description |
|---------|-------------|
| Before spec finalization | Ensure failure modes are specified |
| After core behavior defined | Edge cases depend on happy path |
| Feature involves data mutation | Write, update, delete operations |
| Feature has concurrency potential | Multiple actors, async operations |
| Feature integrates external systems | Dependency failure modes |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Identify normal behavior | Baseline for each key operation |
| 2 | Enumerate abnormal conditions | Edge case list |
| 3 | Define expected system behavior | System response for each case |
| 4 | Define user-visible behavior | HTTP status, UI state, error message |
| 5 | Define logging/metrics implications | Observability requirements |
| 6 | Define test implications | Test type and scenario for each |

## Core Principle

For every important feature action, ask:

| Question | Concern |
|----------|---------|
| What if the input is empty? | Missing data |
| What if the input is invalid? | Malformed input |
| What if the action is repeated? | Duplicates, idempotency |
| What if the state changed concurrently? | Race conditions |
| What if permissions are insufficient? | Access control |
| What if a dependency fails? | Downstream unavailability |
| What if only part of the work succeeds? | Partial failure |
| What if the data is old or inconsistent? | Stale state |
| What if limits are hit? | Rate limits, quotas |
| What if legacy data is involved? | Migration concerns |

## Required Edge-Case Classes

Examine these classes unless clearly not applicable:

| # | Class | Examples |
|---|-------|----------|
| 1 | Empty or missing input/state | No data, null fields, empty collections |
| 2 | Invalid or malformed input | Wrong types, out of range, bad format |
| 3 | Duplicate or replayed action | Double submit, network retry, idempotency key reuse |
| 4 | Conflict or concurrent update | Two users edit same resource, optimistic lock failure |
| 5 | Permission or ownership mismatch | Wrong role, wrong tenant, no access |
| 6 | Stale or outdated client state | Form data loaded before update, stale cache |
| 7 | Partial failure | Batch partially succeeds, multi-step operation fails mid-way |
| 8 | Dependency failure | DB down, API timeout, queue unavailable |
| 9 | Timeout and retry behavior | First attempt times out, retry succeeds or fails |
| 10 | Large volume, paging, or limits | Exceeding limits, pagination edge behavior |
| 11 | Migration and legacy data behavior | Old format data, missing new fields |
| 12 | Observability blind spots | No logs/metrics for failure modes |

## Analysis Method

For each key operation:

| Step | Action |
|------|--------|
| 1 | Identify the normal behavior |
| 2 | Enumerate realistic abnormal conditions |
| 3 | Define expected system behavior |
| 4 | Define expected user-visible behavior |
| 5 | Define logging/metrics implications |
| 6 | Define test implications |

## Output Structure

For each edge case, capture:

| Field | Description |
|-------|-------------|
| Case | Name and description |
| Why it matters | Business or technical impact |
| Trigger condition | How this situation occurs |
| Expected system behavior | Internal system response |
| Expected user-visible behavior | HTTP status, UI state, error message |
| Logging/metrics implications | What to log and track |
| Testing implications | Test type and scenario |

## Commonly Missed Cases

Do not forget:

- Double-click / double-submit
- Retries after uncertain success
- Stale form data
- Deleted or changed related objects
- Role changes mid-session
- Partial persistence success
- Invalid old drafts or legacy entities
- Pagination boundaries
- Race conditions with background jobs
- Eventual consistency gaps
- Duplicate external callbacks or webhooks

## Output Artifact

If a task workspace exists, write findings to:
`docs/specs/<task-id>/edge-cases.md`

Otherwise, return structured output inline.

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not reduce edge cases to form validation only |
| 2 | Consider product, domain, and infrastructure failure modes |
| 3 | If no expected behavior defined for important edge case, flag as incomplete |
| 4 | If repository already encodes edge-case behavior, distinguish from new required behavior |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Only form validation edge cases | Misses domain, infrastructure failure modes | Consider all 12 edge-case classes |
| No behavior for important cases | Leaves gaps in spec | Define behavior or flag as incomplete |
| Ignoring repository behavior | May contradict existing code | Check repo, distinguish old vs new |
| No test implications | Edge cases untestable | Define test type and scenario per case |
| Forgetting observability | Failure modes invisible in prod | Specify logging/metrics per case |
| Only happy-path data | Misses stale, legacy, concurrent states | Include all state derivations |

## Verification Checklist

- [ ] All 12 edge-case classes examined (or explicitly N/A)
- [ ] For each key operation: abnormal conditions enumerated
- [ ] Each edge case has expected system behavior
- [ ] Each edge case has user-visible behavior defined
- [ ] Logging/metrics implications captured per case
- [ ] Testing implications captured per case
- [ ] Commonly missed cases reviewed and addressed
- [ ] Edge cases distinguish repo-encoded behavior from new required behavior
- [ ] `edge-cases.md` written to workspace if applicable
- [ ] Critical gaps (no defined behavior) flagged for spec
