---
name: replan-on-surprise
description: >
  Stop implementation when hidden scope, architectural forks, or systemic issues
  appear, then push the task back through planning with explicit evidence.
---

# Replan On Surprise

Use this skill when implementation reveals more complexity than the approved plan covered.

## Triggers

- `replan-on-surprise: {goal}` - Return the task to analysis or design.
- `scope expanded unexpectedly` - Record the surprise and stop coding.
- `this change is wider than planned` - Create a revised path.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Surprise during execution | Replan decision + updated next stage | Short |

## Process

### Phase 1: Stop The Drift

Prevent silent scope expansion.

1. **Freeze implementation** - Do not continue coding through a new architectural fork.
2. **Record the surprise** - Update kanban with what changed, why it matters, and what is blocked.

**Verification:** The task no longer appears to be safely in implementation.

### Phase 2: Route Back To Planning

Choose the right earlier stage and explain why.

1. **Select the re-entry point** - Send the task back to impact analysis, design, or planning.
2. **Revise the expected path** - Capture the new scope, risk, and next recommended subagent.

**Verification:** The next stage is explicit and justified.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Heroic improvisation | Hides risk and rework | Stop and replan |
| Silent scope creep | Breaks trust in verification | Record the surprise in kanban |

## Verification

After execution:

- [ ] The surprise is logged.
- [ ] Implementation is paused.
- [ ] The task has a revised next stage.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Surprise triggers and re-entry stage rules.
