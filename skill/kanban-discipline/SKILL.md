---
name: kanban-discipline
description: >
  Make kanban the durable record for scope, status, decisions, blockers,
  verification, and review outcomes.
---

# Kanban Discipline

Use this skill whenever task state must be recorded outside the model context.

## Triggers

- `kanban-discipline: {goal}` - Update the task record correctly.
- `log this decision in kanban` - Persist a decision or blocker.
- `move this task to the next stage` - Advance workflow state with evidence.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Task stage + evidence | Updated kanban item and notes | Short |

## Process

### Phase 1: Ensure The Record Exists

Find the task or create it before deeper work continues.

1. **Create or locate item** - Use a feature, issue, or todo item that matches the request.
2. **Populate core fields** - Record objective, scope, acceptance criteria, assumptions, and next step.

**Verification:** The task can be found again without relying on chat history.

### Phase 2: Keep State Current

Update kanban at every meaningful stage transition.

1. **Record decisions and blockers** - Persist rationale, rejected alternatives, and surprises.
2. **Write stage summaries** - Log verification results, review outcome, and residual risk before Done.

**Verification:** Another agent can resume the task from kanban alone.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Leaving decisions only in chat | Process memory gets lost | Log decisions in kanban immediately |
| Marking tasks done without evidence | Hides incomplete work | Require verification and review summaries |

## Verification

After execution:

- [ ] The task exists in kanban.
- [ ] Current stage and next step are recorded.
- [ ] Decisions, blockers, or verification notes are persisted.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Durable rules for kanban-first task state.
