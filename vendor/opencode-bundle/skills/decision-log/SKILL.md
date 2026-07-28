---
name: decision-log
description: >
  Persist non-trivial engineering decisions, rejected alternatives, and accepted
  risks in kanban so process context survives beyond the active session.
---

# Decision Log

Use this skill when the task reaches a meaningful fork or trade-off.

## Triggers

- `decision-log: {goal}` - Record a design or process decision.
- `log this trade-off` - Persist the rationale and rejected options.
- `why did we choose this` - Capture the answer in durable form.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Choice + alternatives + rationale | Kanban decision record | Short |

## Process

### Phase 1: Capture The Decision

Define the choice in a way another agent can understand later.

1. **State the choice** - Describe the decision clearly and specifically.
2. **List rejected alternatives** - Name what was not chosen and why.

**Verification:** The decision can be understood without the surrounding chat.

### Phase 2: Capture The Consequences

Record what the decision implies for future work.

1. **Explain rationale** - Tie the choice to constraints, risk, and goals.
2. **Add follow-up implications** - Note migration, review, or verification consequences.

**Verification:** Future agents can see both the choice and its downstream impact.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Keeping architecture choices only in chat | Loses process memory | Create a decision record in kanban |
| Logging the outcome without rationale | Makes future change hard | Record rejected alternatives and why |

## Verification

After execution:

- [ ] The choice is explicit.
- [ ] Alternatives and rationale are recorded.
- [ ] Follow-up implications are noted.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Required fields for durable decision records.
