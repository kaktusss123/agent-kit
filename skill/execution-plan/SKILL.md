---
name: execution-plan
description: >
  Turn an approved design or low-risk task into an ordered implementation plan
  with touched areas, checks, rollback notes, and definition of done.
---

# Execution Plan

Use this skill after triage or design when work is ready to be sequenced.

## Triggers

- `execution-plan: {goal}` - Build the ordered implementation plan.
- `break this into steps` - Convert scope into a concrete sequence.
- `what do we change first` - Determine execution order and verification path.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Approved scope or design | Ordered plan with checks | Short |

## Process

### Phase 1: Define The Sequence

Translate the intended change into concrete steps.

1. **List touched areas** - Identify files, modules, contracts, and tests likely involved.
2. **Order the work** - Place prerequisites before dependent changes and note rollback points.

**Verification:** The sequence is implementable without guessing the next step.

### Phase 2: Define Done

Tie the plan to clear completion evidence.

1. **Attach validation** - Specify tests, lint, type, build, and manual checks.
2. **State definition of done** - Connect plan completion to acceptance criteria and review readiness.

**Verification:** Each step has an expected output or validation signal.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Vague plans with no order | Encourages improvisation | Produce numbered steps |
| Expanding scope during execution | Breaks reviewability | Update the plan before proceeding |

## Verification

After execution:

- [ ] Steps are ordered and specific.
- [ ] Validation commands or checks are listed.
- [ ] Definition of done is explicit.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Plan structure and definition of done rules.
