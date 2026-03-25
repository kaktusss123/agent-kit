# Contract Impact Audit Domain Knowledge

## Contract Types

### 1. API Contracts

- **REST APIs**: Endpoints, methods, request/response schemas
- **GraphQL**: Queries, mutations, types, fields
- **gRPC**: Service definitions, message types
- **WebSocket**: Message formats, connection lifecycle

### 2. Data Contracts

- **Database schemas**: Tables, columns, constraints, indexes
- **Event schemas**: Event types, payload structures
- **Message queue formats**: Queue messages, routing keys
- **Cache structures**: Key patterns, value formats

### 3. Integration Contracts

- **Webhooks**: Callback URLs, payload formats, retry behavior
- **External APIs**: Third-party service contracts
- **File formats**: Import/export formats, CSV/JSON structures
- **Configuration contracts**: Config file formats, environment variables

### 4. Internal Contracts

- **Frontend-backend**: API contracts between UI and server
- **Service-to-service**: Internal microservice contracts
- **Module interfaces**: Function signatures, class interfaces
- **Observability contracts**: Log formats, metric names, trace attributes

## Change Classification

### Additive Changes (Usually Safe)

- Adding optional fields to request/response
- Adding new endpoints/operations
- Adding new event types
- Adding new enum values (if consumers handle unknown values)
- Adding new optional configuration

### Behavioral Changes (Potentially Breaking)

- Changing validation rules (stricter or looser)
- Changing default values
- Changing error codes or messages
- Changing rate limits or quotas
- Changing timing or ordering guarantees

### Breaking Changes (Requires Migration)

- Removing fields from request/response
- Renaming fields or endpoints
- Changing field types
- Making optional fields required
- Removing enum values
- Changing authentication/authorization requirements

## Compatibility Analysis Framework

### Backward Compatibility

Can old clients work with new server?

- ✅ Safe: New optional fields, new endpoints
- ⚠️ Risky: Changed validation, changed defaults
- ❌ Breaking: Removed fields, renamed fields, changed types

### Forward Compatibility

Can new clients work with old server?

- ✅ Safe: Clients handle missing optional fields
- ⚠️ Risky: Clients expect new fields or behavior
- ❌ Breaking: Clients require new endpoints or fields

### Consumer Impact Assessment

For each contract change:

1. **Identify consumers**: Who/what uses this contract?
2. **Assess impact**: Will they break, degrade, or continue working?
3. **Determine coordination**: Do consumers need updates?
4. **Plan rollout**: Can we deploy independently or need coordination?

## Migration Strategies

### Strategy 1: Expand-Contract Pattern

1. **Expand**: Add new field/endpoint alongside old
2. **Migrate**: Update consumers to use new contract
3. **Contract**: Remove old field/endpoint after migration

### Strategy 2: Versioning

- **URL versioning**: `/v1/users` → `/v2/users`
- **Header versioning**: `Accept: application/vnd.api+json; version=2`
- **Content negotiation**: Different response based on Accept header

### Strategy 3: Feature Flags

- Deploy new contract behind flag
- Enable for subset of consumers
- Gradually roll out
- Remove flag after full migration

### Strategy 4: Dual-Write

- Write to both old and new format
- Read from new format with fallback to old
- Migrate data in background
- Remove old format after migration

## Contract Documentation Requirements

For each affected contract, document:

```markdown
### Contract: [Name]

**Type**: API | Data | Integration | Internal

**Owner**: [Team or service]

**Consumers**: [List of known consumers]

**Change type**: Additive | Behavioral | Breaking

**Backward compatible**: Yes | No | Partial

**Forward compatible**: Yes | No | Partial

**Migration required**: Yes | No

**Rollout strategy**: [Expand-contract | Versioning | Feature flag | Dual-write]

**Coordination required**: [List of teams/services that need updates]

**Risks**:
- [Runtime breakage risks]
- [Silent failure risks]
- [Partial rollout risks]
```

## Testing Requirements

For contract changes:

1. **Contract tests**: Verify schema compatibility
2. **Integration tests**: Test old and new consumers
3. **Backward compatibility tests**: Old client + new server
4. **Forward compatibility tests**: New client + old server
5. **Migration tests**: Verify migration path works

## Anti-Patterns

- ❌ Treating only public APIs as contracts
- ❌ Not documenting internal contract changes
- ❌ Assuming "no one uses this" without verification
- ❌ Breaking changes without versioning or migration
- ❌ Not testing backward/forward compatibility
- ❌ Deploying breaking changes without consumer coordination
