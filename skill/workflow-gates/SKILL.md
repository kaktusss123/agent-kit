---
name: workflow-gates
description: >
  Enforce triage, impact analysis, design, implementation, per-pass commit,
  verification, and review gates for non-trivial engineering work.
---

# Workflow Gates

Use this skill to stop agents from jumping straight into code.

## Triggers

- `workflow-gates: {goal}` - Evaluate which gates the task must pass.
- `run gated workflow for {task}` - Apply the full orchestrated path.
- `is this ready to implement` - Decide whether the next gate is satisfied.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Task request + current state | Required gates + next stage | Short |

## Process

### Phase 1: Classify The Task

Decide whether the task is trivial, direct, design-first, or approval-sensitive.

1. **Assess scope** - Estimate impact, file spread, public surface risk, and unknowns.
2. **Select gates** - Mark whether triage, impact, design, implement, per-pass commit, verify, and review are required.

**Verification:** Every non-trivial task has an explicit next gate before code changes begin.

### Phase 2: Enforce The Sequence

Drive the task through the chosen gates without skipping required stages.

1. **Block early coding** - Do not allow implementation before required analysis and planning complete.
2. **Require per-pass commit** - When `implementer` changes files, require a commit before verification or review.
3. **Repeat the fix loop** - If verification or review require code changes, return to `implementer` and repeat implement -> commit before re-running the gates.

**Verification:** The current stage, satisfied gates, and next stage are all visible in kanban.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Coding before impact analysis | Hides radius of change | Run triage and impact first |
| Treating review as optional | Lets scope creep through | Require review after each implementation commit |
| Delaying commit until review | Breaks checkpoint discipline | Commit immediately after each changed implementation pass |

## Verification

After execution:

- [ ] Required gates are listed explicitly.
- [ ] Current task stage is recorded in kanban.
- [ ] Implementation is blocked until prior gates pass.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Gate definitions and stage selection rules.
