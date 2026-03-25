---
name: contract-impact-audit
description: >
  Audits the impact of the feature on internal and external contracts: APIs,
  events, schemas, queues, persistence surfaces, integration boundaries, and compatibility.
---

# Purpose

Prevent a seemingly local change from breaking adjacent systems.

# What Counts as a Contract

Treat the following as contracts:
- HTTP / RPC APIs
- request / response schemas
- DB schemas and constraints
- event payloads
- queue messages
- background job payloads
- webhooks
- frontend-backend data contracts
- config contracts
- observability conventions where downstream consumers rely on them

# Required Questions

For each relevant contract, determine:
1. does it already exist,
2. does the feature change it,
3. is the change additive, behavioral, or breaking,
4. who consumes it,
5. what compatibility guarantees are required,
6. whether versioning, migration, or fallback is needed.

# Audit Procedure

## 1. Identify affected contracts
List all contracts the feature may touch.

## 2. Classify each change
Classify as:
- no change,
- additive,
- behaviorally changed,
- potentially breaking,
- confirmed breaking.

## 3. Analyze compatibility
Determine:
- backward compatibility needs,
- forward compatibility risks,
- migration requirements,
- consumer coordination requirements.

## 4. Record follow-up needs
Identify required updates to:
- code,
- schemas,
- documentation,
- tests,
- consumers/producers,
- rollout plans.

# Output Format

Produce a structured analysis:

## Affected contracts
- contract name
- owner or producing side
- consuming side
- type of impact

## Compatibility analysis
- what remains compatible
- what may break
- mitigation or rollout strategy

## Required updates
- implementation updates
- documentation updates
- testing updates
- migration/versioning updates

## Risks
- runtime breakage risks
- silent failure risks
- partial rollout risks

# Where to Record Results

Reflect results in:
- `spec.md` under `API / interfaces / contracts` and `Rollout / migration / backward compatibility`,
- `decision-log.md` for compatibility choices,
- `questions-log.md` for unresolved contract decisions,
- `traceability.md` for contract-to-test mapping.

# Hard Rules

1. Do not treat only public APIs as contracts; internal payloads are contracts too.
2. Any data-shape change must be explicitly described.
3. Any incompatibility must be eliminated, versioned, or explicitly accepted.
4. If consumers are unknown, state that explicitly as a risk.
