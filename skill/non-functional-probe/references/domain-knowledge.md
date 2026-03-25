# Non-Functional Probe Domain Knowledge

## Non-Functional Requirement Categories

### 1. Performance

**Latency**:
- Response time targets (p50, p95, p99)
- Acceptable degradation under load
- Timeout values

**Throughput**:
- Requests per second
- Concurrent users
- Batch sizes

**Resource usage**:
- Memory limits
- CPU usage
- Database connections
- Network bandwidth

### 2. Reliability

**Availability**:
- Uptime targets (99.9%, 99.99%)
- Acceptable downtime windows
- Degraded mode behavior

**Fault tolerance**:
- Retry behavior and limits
- Circuit breaker thresholds
- Fallback mechanisms
- Graceful degradation

**Data integrity**:
- Consistency guarantees (strong, eventual, causal)
- Durability requirements
- Backup and recovery

### 3. Security

**Authentication**:
- Auth mechanisms (OAuth, JWT, API keys)
- Session management
- Token expiration

**Authorization**:
- Permission model (RBAC, ABAC)
- Ownership rules
- Tenant isolation

**Data protection**:
- Encryption at rest
- Encryption in transit
- PII handling
- Secret management

**Audit**:
- Audit log requirements
- Compliance needs (GDPR, SOC2)
- Retention policies

### 4. Observability

**Logging**:
- Structured log format
- Log levels and verbosity
- Sensitive data redaction
- Log retention

**Metrics**:
- Business metrics (conversions, usage)
- Technical metrics (latency, errors, throughput)
- Resource metrics (CPU, memory, disk)
- Custom metrics

**Tracing**:
- Distributed trace propagation
- Span attributes
- Sampling strategy

**Alerting**:
- Alert conditions and thresholds
- Alert routing and escalation
- Runbook references

### 5. Operability

**Deployment**:
- Deployment strategy (blue-green, canary, rolling)
- Rollback procedure
- Database migration sequencing
- Configuration management

**Feature flags**:
- Flag granularity (global, tenant, user)
- Flag lifecycle
- Emergency kill switch

**Monitoring**:
- Health check endpoints
- Readiness and liveness probes
- Dashboard requirements

**Maintenance**:
- Backup procedures
- Data cleanup jobs
- Schema migration process

### 6. User-Facing Quality

**User experience**:
- Loading states and skeletons
- Error states and recovery
- Empty states
- Disabled states
- Progress indicators

**Accessibility**:
- WCAG compliance level
- Screen reader support
- Keyboard navigation
- Color contrast

**Internationalization**:
- Supported locales
- Translation requirements
- Date/time/number formatting
- RTL support

**Responsiveness**:
- Supported screen sizes
- Mobile vs desktop behavior
- Offline capabilities

## Non-Functional Requirement Template

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

## Common Non-Functional Patterns

### Idempotency

Required when:
- Operations can be retried
- Network failures are possible
- User might double-submit

Implementation:
- Idempotency keys
- Deduplication windows
- State machine guards

### Rate Limiting

Required when:
- Protecting against abuse
- Managing resource consumption
- Fair usage across tenants

Implementation:
- Token bucket algorithm
- Sliding window counters
- Per-user/per-tenant limits

### Caching

Required when:
- Read-heavy workloads
- Expensive computations
- External API calls

Considerations:
- Cache invalidation strategy
- TTL values
- Cache warming
- Stale data tolerance

### Async Processing

Required when:
- Long-running operations
- Decoupling components
- Handling spikes

Considerations:
- Job queue selection
- Retry and DLQ handling
- Progress tracking
- Result notification

## Non-Functional Trade-offs

### Performance vs Consistency

- Strong consistency: Slower, simpler reasoning
- Eventual consistency: Faster, complex conflict resolution

### Security vs Usability

- Strict auth: More secure, more friction
- Relaxed auth: Better UX, higher risk

### Observability vs Performance

- Detailed logging: Better debugging, higher overhead
- Minimal logging: Lower overhead, harder debugging

### Reliability vs Complexity

- Complex retry logic: More reliable, harder to reason about
- Simple failure handling: Easier to understand, less resilient

## Anti-Patterns

- ❌ Vague requirements ("should be fast", "must be secure")
- ❌ No quantitative targets (no SLOs, no thresholds)
- ❌ Ignoring non-functional requirements until production
- ❌ Not testing non-functional requirements
- ❌ No monitoring for non-functional requirements
- ❌ Treating all operations the same (critical vs non-critical)
