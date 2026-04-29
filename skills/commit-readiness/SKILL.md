---
name: commit-readiness
description: >
  Confirm that kanban state, current stage, blockers, and commit scope are ready
  before delegating to the commit agent.
---

# Commit Readiness

Use this skill immediately before any orchestrator-driven commit.

## Triggers

- `commit-readiness: {goal}` - Evaluate whether commit is allowed.
- `is this ready to commit` - Check workflow completion.
- `prepare commit handoff` - Summarize what the committer may proceed with.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Kanban state + current stage + worktree | Ready or not ready result | Short |

## Process

### Phase 1: Check Stage Readiness

Confirm the current workflow stage allows a safe commit.

1. **Check kanban state** - Ensure the task is in an implementation or fix stage with no unresolved blockers that would invalidate the commit.
2. **Check authority** - Ensure the orchestrator is allowed to create a commit for this implementation pass.

**Verification:** Missing stage requirements are named explicitly.

### Phase 2: Check Commit Scope

Make sure the working tree is coherent for one safe commit.

1. **Inspect scope** - Confirm the staged or intended changes match the task boundary.
2. **Prepare handoff notes** - Suggest commit type, rationale, implementation-pass summary, and the next gate for the commit agent.

**Verification:** The result is either ready with scope notes or blocked with exact gaps.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Delaying a changed implementation pass until after verification or review | Breaks the orchestrator loop | Commit immediately after `implementer` finishes |
| Mixing unrelated changes | Weakens traceability | Keep commit scope coherent |

## Verification

After execution:

- [ ] Kanban readiness is confirmed.
- [ ] The current stage allows a commit.
- [ ] Commit scope is coherent or explicitly blocked.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Commit prerequisites and blocking conditions.
