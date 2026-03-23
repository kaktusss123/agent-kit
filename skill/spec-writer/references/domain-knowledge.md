# Spec Writer Domain Knowledge

## Specification Quality Criteria

A good spec is:
1. **Precise**: No vague statements like "handle errors properly"
2. **Testable**: Every requirement can be verified
3. **Complete**: Covers happy path, edge cases, and failures
4. **Consistent**: No contradictions between sections
5. **Traceable**: Requirements link to goals, scenarios, tests, and acceptance criteria

## Required Sections and Content

### 1-6: Context and Framing

- **Title**: Clear, concise task name
- **Summary**: 2-3 paragraph overview
- **Problem/Motivation**: Pain point and business value
- **Goals**: Concrete outcomes (3-5 items)
- **Non-goals**: Explicitly excluded scope
- **Current state**: How it works today (from repo-scout.md)

### 7-9: Scope and Model

- **Scope**: In-scope and out-of-scope boundaries
- **Actors/Roles**: Users, systems, permissions
- **Domain model**: Entities, fields, relationships, invariants

### 10-13: Requirements

- **Scenarios**: Happy path, alternate paths, failure paths, recovery paths
- **Functional requirements**: Numbered FR-1, FR-2, etc.
- **Business rules**: Numbered BR-1, BR-2, etc.
- **Validation rules**: Numbered VR-1, VR-2, etc.

### 14-19: Technical Details

- **Edge cases and failure handling**: Concrete behaviors for abnormal conditions
- **API/interfaces/contracts**: Requests, responses, events, compatibility
- **Data model and persistence**: Schema changes, migration, indexing
- **Security/permissions**: AuthN/AuthZ, ownership, tenant isolation, audit
- **Observability**: Logs, metrics, traces, dashboards, alerts
- **Rollout/migration/compatibility**: Flags, staged rollout, migration order, rollback

### 20-24: Validation and Appendix

- **Testing strategy**: Unit, integration, contract, E2E, regression
- **Acceptance criteria**: Numbered AC-1, AC-2, etc.
- **Open questions**: Unresolved items
- **Assumptions**: Temporary or explicit assumptions
- **Appendix**: Examples, diagrams, sample payloads

## Writing Principles

### Precision

Bad: "The system should handle errors gracefully"
Good: "If validation fails, return HTTP 400 with error details in RFC 7807 format"

Bad: "Support all common cases"
Good: "Support create, update, and delete operations. Read-only access is out of scope."

### Testability

Bad: "The feature should be fast"
Good: "API response time must be < 200ms at p95 for requests with < 100 items"

Bad: "Provide good error messages"
Good: "Error messages must include: error code, human-readable description, and field name for validation errors"

### Completeness

Every important operation must specify:
- Happy path behavior
- Invalid input behavior
- Empty/missing input behavior
- Duplicate/retry behavior
- Permission denial behavior
- Dependency failure behavior
- Timeout behavior

## Consistency Checks

Before finalizing, verify:

1. **Goals ↔ Requirements**: Each goal maps to ≥1 functional requirement
2. **Scenarios ↔ Requirements**: Each critical scenario has defined behavior
3. **Requirements ↔ Tests**: Each requirement has testing strategy reference
4. **Acceptance ↔ Requirements**: Each AC maps to concrete requirements
5. **Decisions ↔ Spec**: Decisions from decision-log.md are reflected
6. **Assumptions ↔ Spec**: Assumptions are in Assumptions section
7. **Repo facts ↔ Spec**: Current state matches repo-scout.md

## Section Completeness Rules

Every section must contain either:
- Concrete content, OR
- `N/A - [brief explanation why not applicable]`

Never leave sections empty or with placeholder text like "TBD".

## Anti-Patterns

- ❌ Vague requirements that can't be tested
- ❌ Hiding major risks in appendix
- ❌ Presenting inferred behavior as confirmed
- ❌ Masking unresolved decisions as settled
- ❌ Omitting edge cases or failure modes
- ❌ Skipping observability or rollback considerations
- ❌ Contradictions between sections
