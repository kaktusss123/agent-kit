---
name: non-functional-probe
description: >
  Probes non-functional requirements: performance, reliability, security,
  observability, operability, and user-facing quality constraints.
---

# Purpose

Ensure the feature is specified not only by what it does, but by how it must behave in a real system.

# Required Areas

You must consider these areas unless clearly not applicable:

1. Performance
2. Reliability
3. Security
4. Observability
5. Operability
6. User-facing quality attributes

# Area-Specific Guidance

## 1. Performance
Probe:
- latency expectations,
- throughput/volume assumptions,
- batch sizes,
- pagination behavior,
- expensive queries or fan-out calls,
- caching needs,
- synchronous vs asynchronous boundaries.

## 2. Reliability
Probe:
- retry behavior,
- idempotency,
- timeout behavior,
- partial failure handling,
- fallback behavior,
- consistency model,
- failure visibility.

## 3. Security
Probe:
- authentication,
- authorization,
- ownership/tenant isolation,
- sensitive data exposure,
- auditability,
- secret/config handling,
- abuse or misuse risks.

## 4. Observability
Probe:
- structured logs,
- counters and error metrics,
- traces/spans,
- dashboards or key signals,
- alert conditions,
- rollout health signals.

## 5. Operability
Probe:
- feature flags,
- config changes,
- deployment sequencing,
- migration ordering,
- rollback strategy,
- runbook impact,
- support/debugging ergonomics.

## 6. User-Facing Quality
Probe:
- loading states,
- error states,
- empty states,
- disabled states,
- accessibility,
- localization,
- consistency with existing UX patterns.

# Output Format

For each relevant area, capture:
- requirement,
- rationale,
- implementation constraints,
- acceptance signal,
- testing or monitoring implications.

# Where to Record Results

Reflect results in:
- `spec.md` under `Observability`, `Security / permissions`, `Rollout / migration`, `Testing strategy`, and relevant functional sections,
- `questions-log.md` when the requester must clarify trade-offs,
- `decision-log.md` when non-functional choices are accepted.

# Commonly Missed Non-Functional Concerns

Do not forget:
- whether duplicate retries must be safe,
- whether partial results are allowed,
- whether slow operations need asynchronous execution,
- whether rollout should be guarded by a feature flag,
- whether support teams need better logs or audit trails,
- whether access control differs across roles or tenants.

# Hard Rules

1. If the feature touches a critical path, observability requirements are mandatory.
2. If an operation may be retried, idempotency must be specified or explicitly rejected.
3. If the change can be dangerous in production, rollout and rollback guidance is mandatory.
4. Do not bury non-functional requirements as vague statements; they must be testable or observable.
