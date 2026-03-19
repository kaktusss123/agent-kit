---
name: commit-readiness
description: >
  Confirm that kanban state, verification, review, blockers, and commit scope
  are ready before delegating to the commit agent.
---

# Commit Readiness

Use this skill immediately before any requested commit.

## Triggers

- `commit-readiness: {goal}` - Evaluate whether commit is allowed.
- `is this ready to commit` - Check workflow completion.
- `prepare commit handoff` - Summarize what the committer may proceed with.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Kanban state + verification + review + worktree | Ready or not ready result | Short |

## Process

### Phase 1: Check Workflow Completion

Confirm all required gates have completed successfully.

1. **Check kanban state** - Ensure the task is at a ready or done stage with no unresolved blockers.
2. **Check evidence** - Ensure verification and review both exist and passed.

**Verification:** Missing gates are named explicitly.

### Phase 2: Check Commit Scope

Make sure the working tree is coherent for one safe commit.

1. **Inspect scope** - Confirm the staged or intended changes match the task boundary.
2. **Prepare handoff notes** - Suggest commit type, rationale, and verification summary for the commit agent.

**Verification:** The result is either ready with scope notes or blocked with exact gaps.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Committing with failed or missing gates | Breaks workflow discipline | Refuse and explain missing evidence |
| Mixing unrelated changes | Weakens traceability | Keep commit scope coherent |

## Verification

After execution:

- [ ] Kanban readiness is confirmed.
- [ ] Verification and review status are confirmed.
- [ ] Commit scope is coherent or explicitly blocked.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Commit prerequisites and blocking conditions.
