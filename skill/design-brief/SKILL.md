---
name: design-brief
description: >
  Convert task framing and impact findings into a concise engineering design with
  constraints, options, trade-offs, rollback, and test strategy.
---

# Design Brief

Use this skill when risk is medium or high, or when responsibility boundaries are unclear.

## Triggers

- `design-brief: {goal}` - Create a design brief before implementation.
- `prepare design options` - Compare approaches and recommend one.
- `is this ready for implementation` - Check whether architectural ambiguity remains.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Triage + impact report | Short design brief | Short |

## Process

### Phase 1: Frame The Problem

Summarize the engineering problem before proposing solutions.

1. **Capture constraints** - Record goals, non-goals, integration points, and failure boundaries.
2. **List unresolved questions** - Surface forks that can change implementation direction.

**Verification:** The brief explains the problem without prematurely locking into one solution.

### Phase 2: Recommend The Approach

Compare options and define the preferred path.

1. **Evaluate alternatives** - Compare one to three approaches with trade-offs.
2. **Plan for rollback** - Document rollback, migration, observability, and test strategy.

**Verification:** The brief makes the recommended approach and its trade-offs explicit.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Skipping options analysis | Hides trade-offs | Compare reasonable alternatives |
| Approving implementation with unresolved forks | Causes redesign during coding | Stop and escalate the unresolved decision |

## Verification

After execution:

- [ ] Constraints and non-goals are explicit.
- [ ] Alternatives and trade-offs are documented.
- [ ] Rollback and test strategy are included.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Required sections for the design brief.
