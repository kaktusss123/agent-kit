---
name: traceability-check
description: >
  Verifies completeness and traceability of the specification by linking goals,
  scenarios, requirements, edge cases, tests, and acceptance criteria.
---

# Purpose

Ensure that the specification is complete, internally consistent, and ready for implementation and testing.

# Core Principle

A good spec is not just detailed.
It is traceable.

Each important requirement should connect to:
- a goal,
- one or more scenarios,
- one or more tests,
- one or more acceptance criteria.

# What to Check

You must verify the following:

1. Each goal maps to one or more functional requirements.
2. Each important scenario has defined expected behavior.
3. Each major edge case has expected behavior and test implications.
4. Each affected contract has a compatibility treatment.
5. Each important requirement has at least one testing strategy reference.
6. Each acceptance criterion maps back to concrete requirements or behaviors.
7. Open questions and assumptions are not disguised as settled facts.
8. Sections do not contradict each other.

# Recommended Traceability Matrix

Use a structure like:

| Item | Linked goals | Linked scenarios | Linked requirements | Linked tests | Linked acceptance criteria | Notes |
|---|---|---|---|---|---|---|

At minimum, cover:
- functional requirements,
- business rules,
- validation rules,
- edge cases,
- acceptance criteria.

# Output Format

Write results to `traceability.md` using this structure:

## Coverage summary
Overall completeness assessment.

## Coverage matrix
Traceability mapping between requirements, scenarios, tests, and acceptance.

## Gaps
Anything missing coverage.

## Contradictions
Any conflicting statements across sections.

## Ambiguities
Any wording that is still too vague.

## Recommended fixes
Specific changes needed before final approval.

# Review Heuristics

Ask:
- Can a developer implement this without guessing?
- Can QA derive a test plan directly from this?
- Can a reviewer tell what is intentionally out of scope?
- Are permissions and failure modes explicit?
- Is rollout/backward compatibility addressed where needed?

# Where to Record Results

Primary output:
- `traceability.md`

If serious spec issues are found, also update:
- `questions-log.md` for new clarifications,
- `decision-log.md` if a conflict resolution becomes an explicit decision,
- `assumptions.md` if unresolved gaps require temporary assumptions.

# Hard Rules

1. If there are blocking coverage gaps, do not treat the spec as ready.
2. If a requirement cannot be traced to tests or acceptance criteria, flag it.
3. If two sections conflict, do not average them; surface the contradiction explicitly.
4. A traceability pass is not optional for an implementation-ready spec.
