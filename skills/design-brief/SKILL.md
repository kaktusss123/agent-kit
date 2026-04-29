---
name: design-brief
description: "Produces a design brief with problem framing, constraints, approach comparison, trade-offs, and production planning."
---

# Design Brief

Transform task framing and impact findings into a structured design brief with explicit trade-offs and clear rationale.

## Triggers

| Trigger | Description |
|---------|-------------|
| Medium or high risk changes | Multiple viable approaches exist |
| Architectural forks need decisions | Design direction not obvious |
| Before execution planning | Need approved design direction |
| Complex features with trade-offs | No single obvious answer |
| After requirements clarified | Requirements stable enough to design |

## Quick Reference

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Frame the problem | Brief explains problem without locking into one solution |
| 2 | Evaluate options | Each option has clear trade-offs, not just descriptions |
| 3 | Recommend approach | Recommendation is justified, not arbitrary |
| 4 | Plan for production | Production concerns addressed, not deferred |

## Process

### Step 1: Frame The Problem

Summarize the engineering problem before proposing solutions.

| Activity | Description |
|----------|-------------|
| Capture constraints | Goals, non-goals, integration points, failure boundaries |
| List unresolved questions | Surface forks that can change implementation direction |
| Identify risk factors | Highlight areas of uncertainty or complexity |

### Step 2: Evaluate Options

Compare reasonable alternatives with explicit trade-offs.

```
1. **Option 1: [Name]**
   - Approach: [How it works]
   - Pros: [Benefits]
   - Cons: [Drawbacks]
   - Complexity: [Low/Medium/High]
   - Risk: [Low/Medium/High]

2. **Option 2: [Name]**
   - [Same structure]

3. **Option 3: [Name]** (if applicable)
   - [Same structure]
```

### Step 3: Recommend Approach

Select the preferred option with clear rationale.

| Field | Description |
|-------|-------------|
| Recommended approach | Option name |
| Rationale | Why this option over others |
| Accepted trade-offs | What we're giving up |
| Mitigation | How we reduce risks |

### Step 4: Plan for Production

Document operational concerns.

| Field | Description |
|-------|-------------|
| Rollback strategy | How to undo if needed |
| Migration needs | Data/schema/config changes |
| Observability | Logs, metrics, traces needed |
| Test strategy | Unit, integration, E2E coverage |
| Feature flags | If needed for staged rollout |

## Required Design Brief Sections

When risk is medium or high, produce a design brief with these sections:

| # | Section | Content |
|---|---------|---------|
| 1 | Problem Statement | What engineering problem are we solving? |
| 2 | Constraints | Technical, business, and timeline constraints |
| 3 | Non-goals | What we're explicitly not doing |
| 4 | Unresolved Questions | Architectural forks that need decisions |
| 5 | Options Considered | 2-3 approaches with trade-offs |
| 6 | Recommended Approach | Selected option with rationale |
| 7 | Trade-offs | What we're accepting/rejecting |
| 8 | Rollback Strategy | How to undo if needed |
| 9 | Migration Plan | Data/schema/config changes |
| 10 | Observability Plan | Logs, metrics, traces |
| 11 | Test Strategy | Coverage approach |
| 12 | Risks | Known risks and mitigation |

## Output Artifact

If a task workspace exists (`docs/specs/<task-id>/`):
- Write design brief to `design-brief.md`

Otherwise, return structured output inline.

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Skipping options analysis | Hides trade-offs | Compare 2-3 reasonable alternatives |
| Approving design with unresolved forks | Causes redesign during coding | Stop and escalate the unresolved decision |
| Vague recommendations | No clear direction | Explicit rationale and trade-offs |
| No rollback strategy | Risky production changes | Document how to undo |
| Ignoring production concerns | Operational surprises | Address in Step 4 |

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not write code |
| 2 | Do not greenlight implementation when architectural uncertainty remains unresolved |
| 3 | Prefer explicit trade-offs over vague recommendations |
| 4 | Do not skip options analysis for medium/high risk changes |
| 5 | Always document rollback strategy for production changes |

## Verification Checklist

- [ ] Problem framed without premature solution lock-in
- [ ] At least 2 reasonable options compared (unless trivial)
- [ ] Each option has: approach, pros, cons, complexity, risk
- [ ] Recommended option has clear rationale
- [ ] Accepted trade-offs explicitly documented
- [ ] Rollback strategy defined
- [ ] Migration needs documented (if any)
- [ ] Observability plan included
- [ ] Test strategy outlined
- [ ] Risks and mitigations documented
- [ ] Unresolved questions surfaced (if any)
- [ ] Production concerns addressed, not deferred
