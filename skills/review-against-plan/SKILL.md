---
name: review-against-plan
description: >
  Review actual changes against the original objective, impact report, design,
  plan, and verification summary instead of diff-only style checks.
---

# Review Against Plan

Use this skill for independent review after verification passes.

## Triggers

- `review-against-plan: {goal}` - Perform structured review.
- `review this against the plan` - Compare intended and actual change.
- `is there scope creep` - Look for drift beyond the approved task.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Request + plan + implementation + verification | Pass or rework review | Short to medium |

## Process

### Phase 1: Compare Intent And Reality

Review the actual change against the original task definition.

1. **Check alignment** - Compare request, impact report, design, execution plan, and implementation.
2. **Inspect missed areas** - Look for omitted contracts, affected modules, or weak test coverage.

**Verification:** Review conclusions cite the planned intent, not just diff impressions.

### Phase 2: Judge Scope And Quality

Turn observations into a pass or rework decision.

1. **Flag scope creep** - Note any extra behavior or architectural drift.
2. **Issue judgment** - Return pass only when correctness, scope, and coverage align.

**Verification:** The review result is actionable and explains why.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Diff-only review | Misses intent drift | Review against plan and impact |
| Style-only review | Misses correctness and scope | Check behavior, risk, and coverage |

## Verification

After execution:

- [ ] Request, plan, and actual change were compared.
- [ ] Scope creep was assessed explicitly.
- [ ] Final result is pass or rework with reasons.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Review questions and pass or rework logic.
