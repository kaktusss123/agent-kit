---
name: non-functional-probe
description: "Probes non-functional requirements: performance, reliability, security, observability, operability, and user-facing quality constraints."
---

# Non-Functional Probe

Probe non-functional requirements to ensure features are specified not only by what they do, but by how they must behave in a real system.

## Triggers

| Trigger | Description |
|---------|-------------|
| Feature touches critical path | High-traffic or latency-sensitive area |
| Feature involves external integrations | Dependency on remote systems |
| Feature handles sensitive data | Security and compliance concerns |
| Feature changes user-facing behavior | UX quality, accessibility |
| Feature needs operational planning | Rollout, rollback, monitoring |
| Any non-trivial feature | NFRs often implicit, need surfacing |

## Quick Reference

| Area | Key Questions | Output |
|------|---------------|--------|
| Performance | Latency, throughput, batch sizes, caching | Performance requirements |
| Reliability | Retry, idempotency, consistency, fallback | Reliability requirements |
| Security | AuthN/AuthZ, data protection, audit | Security requirements |
| Observability | Logs, metrics, traces, alerts | Observability requirements |
| Operability | Flags, config, deployment, rollback | Operability requirements |
| UX Quality | States, accessibility, localization | UX requirements |

## Area-Specific Guidance

### 1. Performance

Probe:
- Latency expectations (p50, p95, p99)
- Throughput/volume assumptions
- Batch sizes
- Pagination behavior
- Expensive queries or fan-out calls
- Caching needs
- Synchronous vs asynchronous boundaries

### 2. Reliability

Probe:
- Retry behavior
- Idempotency
- Timeout behavior
- Partial failure handling
- Fallback behavior
- Consistency model (strong, eventual, causal)
- Failure visibility

### 3. Security

Probe:
- Authentication mechanisms
- Authorization model (RBAC, ABAC)
- Ownership/tenant isolation
- Sensitive data exposure
- Auditability
- Secret/config handling
- Abuse or misuse risks

### 4. Observability

Probe:
- Structured logs
- Counters and error metrics
- Traces/spans
- Dashboards or key signals
- Alert conditions
- Rollout health signals

### 5. Operability

Probe:
- Feature flags
- Config changes
- Deployment sequencing
- Migration ordering
- Rollback strategy
- Runbook impact
- Support/debugging ergonomics

### 6. User-Facing Quality

Probe:
- Loading states
- Error states
- Empty states
- Disabled states
- Accessibility (WCAG compliance level)
- Localization
- Consistency with existing UX patterns

## NFR Template

For each relevant area, capture:

```markdown
### NFR-[ID]: [Name]

**Category**: Performance | Reliability | Security | Observability | Operability | UX

**Requirement**: [Specific, measurable requirement]

**Rationale**: [Why this matters]

**Implementation constraints**: [Technical limitations or dependencies]

**Acceptance signal**: [How to verify this is met]

**Testing implications**: [How to test this]

**Monitoring implications**: [What to monitor]
```

## Common NFR Patterns

### Idempotency

Required when:
- Operations can be retried
- Network failures are possible
- User might double-submit

### Rate Limiting

Required when:
- Protecting against abuse
- Managing resource consumption
- Fair usage across tenants

### Caching

Required when:
- Read-heavy workloads
- Expensive computations
- External API calls

### Async Processing

Required when:
- Long-running operations
- Decoupling components
- Handling spikes

## Commonly Missed NFR Concerns

Do not forget:

- Whether duplicate retries must be safe
- Whether partial results are allowed
- Whether slow operations need asynchronous execution
- Whether rollout should be guarded by a feature flag
- Whether support teams need better logs or audit trails
- Whether access control differs across roles or tenants

## Output Artifact

If a task workspace exists, write findings to:
`docs/specs/<task-id>/non-functional-requirements.md`

Structure:

| Section | Content |
|---------|---------|
| 1. Performance requirements | Latency, throughput, resource constraints |
| 2. Reliability requirements | Retry, idempotency, consistency |
| 3. Security requirements | AuthN/AuthZ, data protection, audit |
| 4. Observability requirements | Logs, metrics, traces, alerts |
| 5. Operability requirements | Flags, config, deployment, rollback |
| 6. UX quality requirements | States, accessibility, localization |

Otherwise, return structured output inline.

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | If the feature touches a critical path, observability requirements are mandatory |
| 2 | If an operation may be retried, idempotency must be specified or explicitly rejected |
| 3 | If the change can be dangerous in production, rollout and rollback guidance is mandatory |
| 4 | Do not bury NFRs as vague statements; they must be testable or observable |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Only functional requirements | System fails under real conditions | Probe all 6 NFR areas |
| Vague NFR statements | Not verifiable | Use measurable targets (p95, max latency, etc.) |
| Skipping observability for critical paths | Blind in production | Make observability mandatory |
| Assuming idempotency without specifying | Data corruption risk | Specify or explicitly reject |
| No rollout/rollback for dangerous changes | Production risk | Document rollout plan |
| Ignoring UX states | Poor user experience | Specify loading, error, empty, disabled states |

## Verification Checklist

- [ ] All 6 NFR areas examined (or explicitly N/A)
- [ ] Performance: latency targets, throughput, caching, async boundaries defined
- [ ] Reliability: retry, idempotency, timeout, consistency defined
- [ ] Security: AuthN/AuthZ, data protection, audit defined
- [ ] Observability: logs, metrics, traces, alerts defined
- [ ] Operability: flags, config, deployment, rollback defined
- [ ] UX: loading, error, empty, disabled states, accessibility defined
- [ ] Each NFR uses measurable/verifiable language
- [ ] Critical path has mandatory observability requirements
- [ ] Retriable operations have idempotency specified or rejected
- [ ] Dangerous production changes have rollout/rollback guidance
- [ ] `non-functional-requirements.md` written if workspace exists
