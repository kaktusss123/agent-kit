---
name: verification-gate
description: >
  Require explicit verification summaries covering tests, checks, acceptance
  criteria, drift, and residual risk before review or commit.
---

# Verification Gate

Use this skill after implementation and before review or commit.

## Triggers

- `verification-gate: {goal}` - Produce the verification summary.
- `is this verified` - Check whether evidence is sufficient.
- `prepare for review` - Confirm verification before handoff.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Implementation result + acceptance criteria | Verification summary | Short to medium |

## Process

### Phase 1: Gather Evidence

Run and collect the relevant validation signals.

1. **Run checks** - Execute tests, lint, type, build, and manual validation when applicable.
2. **Check acceptance criteria** - Confirm each criterion has evidence or note the gap.

**Verification:** The summary is backed by named checks, not just confidence.

### Phase 2: Judge Readiness

Decide whether the task can advance.

1. **Call out residual risk** - Note uncovered edges, skipped checks, and manual follow-up needs.
2. **Recommend pass or rework** - Route the task to review only when verification is sufficient.

**Verification:** Reviewers can see what was actually validated.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Saying tested without listing checks | Hides gaps | Name every check run |
| Ignoring acceptance criteria | Breaks definition of done | Tie criteria to evidence |

## Verification

After execution:

- [ ] Checks run are listed.
- [ ] Acceptance criteria status is explicit.
- [ ] Residual risks and manual notes are recorded.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Verification evidence and pass criteria.
