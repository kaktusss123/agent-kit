---
name: dev2-implementation
description: "Procedural playbook for bounded Dev2 implementation work."
---

# Dev2 Implementation

Use this skill when `dev2-implementer` receives an approved implementation handoff.

## Operating Contract

- Work only inside the explicit handoff scope.
- Do not delegate to another agent.
- Return `needs_more_context` when scope, acceptance criteria, or file targets are missing.
- Preserve existing architecture unless the handoff explicitly approves a design change.
- Keep changes coherent enough for one commit.

## Process

### 1. Validate the Handoff

Before editing files, confirm that the prompt includes:

1. Objective and acceptance criteria.
2. Allowed files, modules, or search boundaries.
3. Non-goals and must-not-touch paths.
4. Test obligations or expected verification commands.
5. Known risks, decisions, and blockers.

If any required item is missing, stop and return `needs_more_context` with a missing-items list.

### 2. Reconstruct the Current Behavior

Read the smallest set of files needed to understand the existing behavior.

Capture evidence before changing code:

- exact file paths;
- relevant function, class, or config names;
- observable behavior that the change preserves or alters.

Do not assume patterns from memory. Use repository evidence.

### 3. Edit Minimally

Apply the smallest coherent change that satisfies the accepted scope.

Use this order:

1. Update production/config behavior.
2. Update tests only at a logical stage boundary.
3. Update documentation only when the handoff requests it or behavior-facing docs become inaccurate.

Avoid broad refactors, formatting-only churn, and unrelated cleanup.

### 4. Self-Check the Diff

Inspect changed files before returning:

1. Does every changed file map to the handoff?
2. Did any non-goal or must-not-touch path change?
3. Are comments current-state descriptions rather than history notes?
4. Are secrets, tokens, and local paths absent from new code?
5. Are test obligations either fulfilled or explicitly carried forward?

### 5. Report for the Orchestrator

Return this structure:

```text
## IMPLEMENTATION COMPLETE
Status: changed | no-op | blocked | needs_more_context
Changed files:
- path: reason
Acceptance criteria covered:
- criterion: evidence
Test obligations:
- fulfilled:
- remaining:
Deviations:
- none | item + rationale
Verification suggestions:
- command or manual check + reason
```

## Stop Conditions

Stop without editing more files when:

- the change requires an unapproved architecture decision;
- the observed repository behavior contradicts the plan;
- the required verification path is unavailable;
- the same failure persists after a focused fix attempt.

## Anti-Patterns

| Avoid | Why | Use Instead |
|---|---|---|
| Guessing missing requirements | Creates hidden scope | Return `needs_more_context` |
| Editing broad areas for convenience | Weakens review and rollback | Make one coherent scoped diff |
| Adding unavailable hooks | Misleads agents and users | Describe only current behavior |
| Hiding test gaps | Breaks verification | Record remaining obligations |
