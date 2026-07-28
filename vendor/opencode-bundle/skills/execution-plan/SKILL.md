---
name: execution-plan
description: "Translates an approved design into concrete ordered implementation steps with file/module identification, rollback points, validation signals, and definition of done."
---

# Execution Plan

Translate an approved design into a safe, ordered engineering plan with concrete implementation steps.

## Triggers

| Trigger | Description |
|---------|-------------|
| Design brief approved | Ready to plan implementation |
| Before implementation starts | Need ordered steps and validation |
| Complex multi-step features | Many files and dependencies |
| Features with rollback requirements | Production changes need undo capability |
| Any non-trivial implementation task | More than one file change |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Define the sequence | Ordered steps, touched areas, rollback points |
| 2 | Define validation | Per-step and overall validation signals |
| 3 | Define done | Functional and technical completion criteria |

## Execution Planning Process

### Step 1: Define The Sequence

Translate the design into concrete steps.

**List touched areas:**

| Area | Examples |
|------|----------|
| Files to create/modify | Source files, test files, config files |
| Modules affected | Packages, services, components |
| Contracts changed | APIs, events, schemas |
| Tests needed | Unit, integration, E2E tests |

**Order the work:**

```
- Step 1: [Action] - [Why first]
- Step 2: [Action] - [Dependencies]
- Step 3: [Action] - [Dependencies]
- ...
- Step N: [Action] - [Completion signal]
```

**Mark rollback points:**

```
- After step X: [Safe rollback point]
- After step Y: [Safe rollback point]
```

**Verification:** The sequence is implementable without guessing the next step.

### Step 2: Define Validation

Specify how to verify each step and overall completion.

**Per-step validation:**

```
- Step 1: [Expected output or check]
- Step 2: [Expected output or check]
```

**Overall validation:**

| Check | Requirement |
|-------|-------------|
| Tests | Which tests must pass |
| Lint | Linting requirements |
| Type check | Type checking requirements |
| Build | Build requirements |
| Manual checks | What to verify manually |

**Verification:** Each step has an expected output or validation signal.

### Step 3: Define Done

Connect plan completion to acceptance criteria.

**Functional completion:**

| AC | Verification |
|----|--------------|
| [AC-1] | How this is verified |
| [AC-2] | How this is verified |

**Technical completion:**

- All tests passing
- No lint/type errors
- Documentation updated
- Review-ready

**Handoff readiness:**

- Verification summary prepared
- Review scope defined
- Rollback procedure documented

**Verification:** Definition of done is explicit and checkable.

## Required Execution Plan Sections

For all non-trivial tasks, produce an execution plan with:

| # | Section | Content |
|---|---------|---------|
| 1 | Touched Areas | Files, modules, contracts, tests |
| 2 | Ordered Steps | Numbered sequence with dependencies |
| 3 | Rollback Points | Safe points to revert |
| 4 | Validation | Per-step and overall checks |
| 5 | Definition of Done | Completion criteria |
| 6 | Estimated Complexity | Time/effort estimate |

## Output Artifact

If a task workspace exists (`docs/specs/<task-id>/`):
- Write execution plan to `execution-plan.md`

Otherwise, return structured output inline.

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Vague plans with no order | Encourages improvisation | Produce numbered steps with dependencies |
| Expanding scope during execution | Breaks reviewability | Update the plan before proceeding |
| No rollback strategy | Risky production changes | Document how to undo |
| No per-step validation | Cannot verify progress | Define expected output per step |
| Vague definition of done | No completion standard | Connect to acceptance criteria |
| No touched-areas list | Missing files or contracts | List all files, modules, contracts |

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not write code |
| 2 | Do not create execution plans without clear validation signals |
| 3 | Do not approve plans that expand scope without updating the design |
| 4 | Always document rollback strategy for production changes |
| 5 | Prefer explicit ordering over grouped or unordered tasks |

## Verification Checklist

- [ ] Touched areas listed (files, modules, contracts, tests)
- [ ] Steps are numbered and ordered with dependency rationale
- [ ] Each step has expected output or validation signal
- [ ] Rollback points marked at safe positions
- [ ] Per-step validation defined
- [ ] Overall validation defined (tests, lint, typecheck, build)
- [ ] Definition of done connects to acceptance criteria
- [ ] Technical completion criteria specified
- [ ] Handoff readiness criteria specified
- [ ] Estimated complexity noted
- [ ] Scope matches approved design (no scope creep)
