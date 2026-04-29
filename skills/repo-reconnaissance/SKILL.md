---
name: repo-reconnaissance
description: "Repository reconnaissance for understanding current system state relevant to a feature request. Explores codebase, identifies modules, patterns, constraints, and impact areas."
---

# Repo Reconnaissance

Understand the current repository state relevant to a feature request. Generate task-scoped reconnaissance artifacts for the specification agent.

## Triggers

| Trigger | Description |
|---------|-------------|
| Before any design or spec work | Need to understand existing system |
| Feature affects existing code paths | Must know current behavior |
| Impact analysis needed | Identify which modules are involved |
| Pattern matching required | Find similar implementations to follow |
| Constraint identification | Surface architectural invariants |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Locate relevant code areas | Routes, handlers, models, schemas, UI |
| 2 | Reconstruct current behavior | How system works today |
| 3 | Find analogous implementations | Similar features, reusable patterns |
| 4 | Identify constraints | Architecture, compatibility, risks |
| 5 | Produce impact map | Likely touched modules with rationale |

## Scope of Work

Must investigate:

| # | Area | What to Find |
|---|------|--------------|
| 1 | Entry points | Routes, event handlers, CLI commands |
| 2 | Domain entities | Core models, aggregates, value objects |
| 3 | Data flow | Request-to-response path, persistence |
| 4 | Existing similar implementations | Neighboring flows, reusable patterns |
| 5 | Validation patterns | Input validation approach and framework |
| 6 | Permission patterns | AuthZ model, role checks, guards |
| 7 | Contract surfaces | APIs, events, queues, webhooks |
| 8 | Persistence/model impact | Schema, migrations, queries |
| 9 | Observability hooks | Logging, metrics, traces |
| 10 | Architectural constraints | Patterns, coupling, legacy boundaries |

## Investigation Path

### 1. Locate Relevant Code Areas

Find:
- Routes
- Handlers/controllers
- Services/use-cases
- Domain models
- Schemas/types
- UI/screens/components
- Jobs/workers/events
- Integrations
- Configuration surfaces (where relevant)

### 2. Reconstruct Current Behavior

Describe how the current system behaves today in the relevant area.

### 3. Find Analogous Implementations

Look for similar features, neighboring flows, or reusable patterns.

### 4. Identify Constraints

Find:
- Established architectural patterns
- Existing invariants
- Backward-compatibility concerns
- Coupling points
- Risky modules
- Known legacy or migration boundaries

### 5. Produce Impact Map

List likely touched modules and why.

## Evidence Discipline

Distinguish clearly between evidence levels:

| Level | Phrase to Use |
|-------|---------------|
| Repository evidence | "Repository evidence suggests..." |
| Reasonable inference | "This appears likely, but could not be fully confirmed from the inspected code..." |
| Missing evidence | "No direct evidence was found for..." |

Never state an inference as if it were proven.

## Output Format

Write `repo-scout.md` with this structure:

| Section | Content |
|---------|---------|
| 1. Recon summary | High-level findings |
| 2. Current system snapshot | How the relevant system works today |
| 3. Relevant modules | Modules and files involved |
| 4. Existing patterns to follow | Patterns discovered in codebase |
| 5. Related / analogous implementations | Similar features found |
| 6. Constraints | Architectural and compatibility constraints |
| 7. Likely impact area | Modules likely to be touched |
| 8. Risks | Identified risks |
| 9. Unknowns / gaps | What repository does not reveal |

## Handoff Expectations

Structure findings so the spec agent can easily:
- Append repository-derived ambiguities into `questions-log.md`
- Append repository-derived implementation constraints into `decision-log.md` when confirmed
- Reuse module map in the "Current state" section of `spec.md`

## Tool Guidance

If semantic code graph, symbol navigation, or repository graph tools exist, prefer them over naive filename scanning. Use search, symbol references, and call relationships whenever available.

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not stop at filenames; reconstruct behavior flows |
| 2 | Do not infer behavior from names only; inspect real usage and contracts |
| 3 | If the repository does not reveal enough, state that explicitly |
| 4 | If there are multiple plausible implementations, note them |
| 5 | Distinguish between evidence and inference |
| 6 | Do not expand into requirement design beyond what repo already implies |
| 7 | Do not decide product behavior not already encoded in the repository |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Reading filenames only | Misses actual behavior | Inspect real usage and contracts |
| Stating inference as fact | Misleads spec agent | Use evidence discipline phrases |
| Requirement design during recon | Scope creep | Stick to what repo reveals |
| Skipping impact map | Unclear change radius | List likely touched modules |
| Ignoring analogous implementations | Reinvents patterns | Find and reference existing code |
| Not naming unknowns | Hidden risks | State explicitly what's missing |

## Verification Checklist

- [ ] Entry points located and described
- [ ] Current system behavior reconstructed
- [ ] Analogous implementations found and referenced
- [ ] Constraints identified and documented
- [ ] Impact map lists modules with rationale
- [ ] Evidence discipline used throughout (no inference stated as fact)
- [ ] Unknowns/gaps explicitly documented
- [ ] Findings structured for easy transfer to spec artifacts
- [ ] No requirement design or product decisions made
- [ ] `repo-scout.md` follows required output format
