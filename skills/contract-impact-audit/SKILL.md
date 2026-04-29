---
name: contract-impact-audit
description: "Audits the impact of features on internal and external contracts: APIs, events, schemas, queues, persistence surfaces, integration boundaries, and compatibility."
---

# Contract Impact Audit

Audit feature impact on contracts to prevent seemingly local changes from breaking adjacent systems.

## Triggers

| Trigger | Description |
|---------|-------------|
| Feature changes data shapes | Request/response, DB schemas, event payloads |
| Feature adds or modifies endpoints | API surface changes |
| Feature changes async messaging | Event, queue, webhook payload changes |
| Feature interacts with integrations | External system boundaries |
| Feature modifies persistence | Schema migrations, constraint changes |
| Any change to shared boundaries | Config contracts, observability conventions |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Identify affected contracts | Full list of contracts the feature may touch |
| 2 | Classify each change | No-change / Additive / Behavioral / Potentially breaking / Confirmed breaking |
| 3 | Analyze compatibility | Backward/forward compatibility, migration needs |
| 4 | Record follow-up needs | Code, schema, doc, test, consumer updates |

## What Counts as a Contract

Treat the following as contracts:

| Contract Type | Examples |
|---------------|----------|
| HTTP / RPC APIs | REST endpoints, gRPC services |
| Request / response schemas | JSON shapes, protobuf messages |
| DB schemas and constraints | Tables, columns, indexes, FKs, unique constraints |
| Event payloads | Kafka, EventBridge, SQS messages |
| Queue messages | Job payloads, message formats |
| Background job payloads | Sidekiq, Celery, Cron job arguments |
| Webhooks | Outbound callbacks to external systems |
| Frontend-backend data contracts | API response shapes consumed by UI |
| Config contracts | Environment variables, config file schemas |
| Observability conventions | Log formats, metric names, span attributes |

## Required Questions

For each relevant contract, determine:

| # | Question |
|---|----------|
| 1 | Does it already exist? |
| 2 | Does the feature change it? |
| 3 | Is the change additive, behavioral, or breaking? |
| 4 | Who consumes it? |
| 5 | What compatibility guarantees are required? |
| 6 | Whether versioning, migration, or fallback is needed |

## Audit Procedure

### Step 1: Identify Affected Contracts

List all contracts the feature may touch.

### Step 2: Classify Each Change

Classify as:

| Classification | Description |
|---------------|-------------|
| No change | Contract not affected |
| Additive | New optional fields, new endpoints |
| Behavioral | Changed validation, defaults, timing |
| Potentially breaking | Needs verification |
| Confirmed breaking | Removes fields, changes types |

### Step 3: Analyze Compatibility

Determine:
- Backward compatibility needs
- Forward compatibility risks
- Migration requirements
- Consumer coordination requirements

### Step 4: Record Follow-up Needs

Identify required updates to:
- Code
- Schemas
- Documentation
- Tests
- Consumers/producers
- Rollout plans

## Change Classification

### Additive Changes (Usually Safe)

- Adding optional fields to request/response
- Adding new endpoints/operations
- Adding new event types
- Adding new enum values (if consumers handle unknown values)

### Behavioral Changes (Potentially Breaking)

- Changing validation rules
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

## Migration Strategies

### Expand-Contract Pattern

| Phase | Action |
|-------|--------|
| 1. Expand | Add new field/endpoint alongside old |
| 2. Migrate | Update consumers to use new contract |
| 3. Contract | Remove old field/endpoint after migration |

### Versioning

| Strategy | Example |
|----------|---------|
| URL versioning | `/v1/users` → `/v2/users` |
| Header versioning | `Accept: application/vnd.api+json; version=2` |
| Content negotiation | Vary by content type |

### Feature Flags

| Phase | Action |
|-------|--------|
| 1 | Deploy new contract behind flag |
| 2 | Enable for subset of consumers |
| 3 | Gradually roll out |

### Dual-Write

| Phase | Action |
|-------|--------|
| 1 | Write to both old and new format |
| 2 | Read from new format with fallback to old |
| 3 | Migrate data in background |

## Output Artifact

If a task workspace exists, write findings to:
`docs/specs/<task-id>/contract-impact.md`

Structure:

| Section | Content |
|---------|---------|
| 1. Affected contracts | List with impact classification |
| 2. Compatibility analysis | What remains compatible, what may break |
| 3. Required updates | Implementation, documentation, testing, migration |
| 4. Risks | Runtime breakage, silent failure, partial rollout risks |
| 5. Recommended strategy | Migration approach |

Otherwise, return structured output inline.

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not treat only public APIs as contracts; internal payloads are contracts too |
| 2 | Any data-shape change must be explicitly described |
| 3 | Any incompatibility must be eliminated, versioned, or explicitly accepted |
| 4 | If consumers are unknown, state that explicitly as a risk |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Only checking public APIs | Misses internal contract breaks | Check all contract types |
| Assuming additive changes are always safe | Behavioral changes in adjacent contracts | Verify consumer handling of new fields |
| Ignoring unknown consumers | Silent breakage risk | State "unknown consumers" as explicit risk |
| No migration strategy for breaking changes | Production impact | Define expand-contract, versioning, or flagging |
| Skipping behavioral changes | Often the most subtle breaks | Classify behavioral as potentially breaking |
| No rollout plan | Risky contract deployment | Plan phased consumer migration |

## Verification Checklist

- [ ] All contract types examined (API, schema, events, queues, webhooks, etc.)
- [ ] Each affected contract classified (no-change / additive / behavioral / breaking)
- [ ] Additive changes verified as consumer-safe
- [ ] Breaking changes have explicit migration strategy
- [ ] Unknown consumers identified as risk
- [ ] Behavioral changes flagged as potentially breaking
- [ ] Migration strategy selected (expand-contract / versioning / feature-flag / dual-write)
- [ ] Follow-up needs recorded (code, schema, docs, tests, consumers)
- [ ] `contract-impact.md` written to workspace if applicable
