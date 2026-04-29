# Edge Case Harvester Domain Knowledge

## Edge Case Taxonomy

### Category 1: Input Anomalies

- **Empty input**: No data provided
- **Missing required fields**: Partial data
- **Invalid format**: Malformed data (bad JSON, invalid email, etc.)
- **Out of range**: Values outside acceptable bounds
- **Invalid combinations**: Cross-field validation failures
- **Oversized input**: Exceeds size limits

### Category 2: State Anomalies

- **Empty state**: No existing data to operate on
- **Stale state**: Client has outdated data
- **Inconsistent state**: Data violates invariants
- **Deleted dependencies**: Related objects no longer exist
- **Changed dependencies**: Related objects modified
- **Locked resources**: Resource in use by another operation

### Category 3: Concurrency Issues

- **Duplicate submission**: Same request sent twice
- **Concurrent updates**: Multiple users editing same resource
- **Race conditions**: Timing-dependent behavior
- **Optimistic locking failures**: Version mismatch
- **Distributed transaction failures**: Partial success across services

### Category 4: Permission Issues

- **Unauthenticated access**: No credentials
- **Unauthorized access**: Insufficient permissions
- **Ownership mismatch**: User doesn't own resource
- **Tenant isolation violation**: Cross-tenant access attempt
- **Role change mid-session**: Permissions revoked during operation

### Category 5: Dependency Failures

- **Database unavailable**: Persistence layer down
- **External service timeout**: Third-party API slow/down
- **Network partition**: Connectivity issues
- **Partial service degradation**: Some dependencies failing
- **Circuit breaker open**: Service protection triggered

### Category 6: Volume and Limits

- **Rate limit exceeded**: Too many requests
- **Quota exceeded**: Resource limits hit
- **Pagination boundaries**: First/last page edge cases
- **Batch size limits**: Too many items in batch
- **Storage limits**: Disk/memory exhausted

### Category 7: Legacy and Migration

- **Old schema data**: Pre-migration records
- **Missing fields**: Data created before field added
- **Deprecated values**: Old enum values or statuses
- **Format changes**: Data in old format
- **Partial migration state**: Some data migrated, some not

### Category 8: Retry and Idempotency

- **Retry after success**: Operation succeeded but client didn't know
- **Retry after failure**: Operation failed, client retries
- **Retry after timeout**: Uncertain outcome
- **Duplicate idempotency key**: Same key used for different operation
- **Expired idempotency window**: Key too old

## Edge Case Analysis Template

For each important operation, document:

```markdown
### Edge Case: [Name]

**Category**: [Input/State/Concurrency/Permission/Dependency/Volume/Legacy/Retry]

**Why it matters**: [Business or technical impact]

**Trigger condition**: [How this situation occurs]

**Expected system behavior**:
- [Internal system response]
- [Data changes or side effects]
- [Error handling or recovery]

**Expected user-visible behavior**:
- [HTTP status code or UI state]
- [Error message or feedback]
- [Available actions]

**Logging/metrics implications**:
- [What to log]
- [What metrics to increment]
- [Alert conditions]

**Testing implications**:
- [Test type: unit/integration/E2E]
- [Test scenario description]
```

## Commonly Missed Edge Cases

### Double-Submit Scenarios

- Form submitted twice due to slow response
- API call retried by client library
- User clicks button multiple times
- Browser back/forward navigation

### Stale Data Scenarios

- User has form open for hours
- Related object deleted by another user
- Permissions changed while form open
- Cached data outdated

### Partial Failure Scenarios

- Database write succeeds, event publish fails
- First API call succeeds, second fails
- File uploaded, metadata save fails
- Payment processed, order creation fails

### Eventual Consistency Scenarios

- Read-after-write returns old data
- Search index not yet updated
- Cache not yet invalidated
- Replica lag in distributed database

## Edge Case Prioritization

**P0 - Critical**: Data loss, security breach, system crash
**P1 - High**: User-facing errors, data inconsistency
**P2 - Medium**: Degraded UX, recoverable errors
**P3 - Low**: Edge cases with workarounds

## Anti-Patterns

- ❌ Reducing edge cases to form validation only
- ❌ Assuming "it won't happen in practice"
- ❌ Deferring all edge cases to "future work"
- ❌ Not specifying expected behavior for known edge cases
- ❌ Treating all edge cases as "return error"
