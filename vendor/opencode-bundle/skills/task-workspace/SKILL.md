---
name: task-workspace
description: >
  Initializes and maintains a task-scoped specification workspace for a single
  feature or change request. Ensures that logs and artifacts are isolated per task.
---

# Purpose

Create and maintain a dedicated workspace for each specification task so that
questions, decisions, assumptions, and generated artifacts do not overwrite each other across tasks.

# Triggers

| If the user says… | Then… |
|---|---|
| `initialize task workspace` | Create workspace at `docs/specs/<task-id>/` |
| `create spec workspace for EVODP-XXXX` | Create workspace with ticket-based task ID |
| `set up task folder` | Create workspace with auto-derived task ID |
| `init spec dir` | Create workspace with auto-derived task ID |
| `start a new spec` | Clarify task ID, then initialize workspace |

# Quick Reference

| Input | Output | Duration |
|---|---|---|
| Task ID + request description | Workspace at `docs/specs/<task-id>/` with 6 minimum files | Short (<1min) |

# Workspace Layout

Each task must use:

`docs/specs/<task-id>/`

Minimum files:
- `spec.md`
- `decision-log.md`
- `questions-log.md`
- `repo-scout.md`
- `assumptions.md`
- `traceability.md`

# Task ID Rules

Prefer, in order:
1. issue/ticket key **with slug** if provided (e.g. `EVODP-9741-web-sql-agent`),
2. explicit task identifier from the user **with slug**,
3. stable slug derived from the task title (e.g. `web-sql-agent`).

Task IDs **must always include a human-readable slug** appended after the ticket key (separated by `-`).
The slug is a short kebab-case summary of the task title (2–5 words max).

Example: ticket `EVODP-9741` + title "Web SQL Agent" → task-id `EVODP-9741-web-sql-agent`.
For personal/non-ticket tasks: use kanban item ID **with slug**, e.g. `183-task-workspace-fix`.

Task IDs should be concise, human-readable, and stable.

# File Responsibilities

## spec.md
The current implementation-ready specification.

Must contain the following sections:

1. Title
2. Summary
3. Problem / Motivation
4. Goals
5. Non-goals
6. Current state
7. Scope
8. Actors / Roles
9. Domain model
10. Scenarios
11. Functional requirements
12. Business rules
13. Validation rules
14. Edge cases and failure handling
15. API / interfaces / contracts
16. Data model and persistence impact
17. Security / permissions
18. Observability
19. Rollout / migration / backward compatibility
20. Testing strategy
21. Acceptance criteria
22. Open questions
23. Assumptions
24. Appendix

## decision-log.md
Append-only decision history for this task.

Each entry should include:
- Decision ID
- Timestamp if available
- Status (`proposed`, `accepted`, `superseded`, `rejected`)
- Decision statement
- Rationale
- Alternatives considered
- Consequences / downstream impact

## questions-log.md
Append-only clarification history for this task.

Each entry should include:
- Question ID
- Category
- Why it matters
- Question text
- User answer
- Resolution status (`open`, `partially resolved`, `resolved`)

## repo-scout.md
Repository reconnaissance artifact produced by the scout subagent.

## assumptions.md
Explicit temporary assumptions that are not yet validated.

Each entry should include:
- Assumption ID
- Assumption statement
- Why it exists
- Impact if false
- Current status (`active`, `validated`, `invalidated`, `superseded`)

## traceability.md
Coverage matrix between requirements, scenarios, tests, and acceptance criteria.

# Logging Rules

1. Never use one global decision log for all tasks.
2. Never use one global question log for all tasks.
3. Append within a task; do not overwrite history.
4. If a prior decision changes, mark the old one as superseded.
5. If a question is revisited, preserve both the original and the updated resolution.
6. If an assumption is resolved, do not delete it; update its status and reference the resolving decision if applicable.

# Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| One global decision log for all tasks | Decisions from different tasks intermingle; no per-task audit trail | Create a task-scoped `decision-log.md` |
| One global question log for all tasks | Answers for different tasks get confused | Create a task-scoped `questions-log.md` |
| Deleting superseded decisions | Erases audit trail; can't trace why a decision changed | Mark as `superseded`, keep the entry |
| Overwriting log history | Destroys context; can't reconstruct timeline | Append new entries, never overwrite |
| Merging unrelated tasks into one workspace | Breaks traceability; creates confusion | Separate workspace per task |
| Using workspace as scratch space | Pollutes spec artifacts; hard to distinguish draft from final | Use a temp/scratch directory for drafts |

# When to Initialize

Initialize a workspace:
- at the first serious intake of a new feature/change request,
- before deep clarification begins,
- before repository scouting output is stored.

# Verification

After initializing a workspace, confirm all of the following:

- [ ] Existing workspace detection was performed before creating a new directory
- [ ] Workspace directory exists at `docs/specs/<task-id>/` where task-id includes a slug
- [ ] All 6 minimum files present: `spec.md`, `decision-log.md`, `questions-log.md`, `repo-scout.md`, `assumptions.md`, `traceability.md`
- [ ] `questions-log.md` has the original request recorded with resolution status `open`
- [ ] `decision-log.md` has at least a skeletal section (Decision ID, Status, Decision, Rationale, Alternatives considered, Consequences)
- [ ] `assumptions.md` has at least a skeletal section (Assumption ID, Statement, Reason, Impact if false, Status)
- [ ] `traceability.md` has at least a skeletal section (placeholder content acceptable at init)
- [ ] Resolved workspace path was recorded and passed to all subagents

# Existing Workspace Detection

**Always search for an existing workspace before creating a new one.**

Detection procedure:
1. Extract the ticket key from the task (e.g. `EVODP-9741`).
2. Run `ls docs/specs/` and look for any directory that starts with that ticket key.
3. If a match is found (e.g. `EVODP-9741-web-sql-agent`), use that directory as-is — do NOT create a new one.
4. If no ticket key exists, search by slug keywords using glob or ls.
5. Only create a new directory when no existing match is found.

Record the resolved workspace path early and pass it explicitly to every subagent.

# Initialization Procedure

For a new task:
1. determine `<task-id>` with slug (see Task ID Rules);
2. **run existing workspace detection** (see above);
3. if an existing directory was found, use it — skip to step 5;
4. create `docs/specs/<task-id>/`;
5. initialize the minimum artifact files if missing;
6. record the original request in `questions-log.md`;
7. initialize empty or skeletal sections in the other files as needed.

# Suggested Initial File Skeletons

## decision-log.md

Each entry follows this format:

```markdown
## Decision D-001

**Status**: accepted | proposed | superseded | rejected
**Date**: YYYY-MM-DD
**Decision**: Clear statement of what was decided
**Rationale**: Why this choice was made
**Alternatives considered**: What was rejected and why
**Consequences**: Downstream impact and trade-offs
```

## questions-log.md

Each entry follows this format:

```markdown
## Question Q-001

**Category**: scope | actors | behavior | data | validation | failure | compatibility | acceptance
**Why it matters**: Impact on implementation or user experience
**Question**: Concrete question with consequence framing
**Answer**: User's response
**Resolution status**: open | partially resolved | resolved
**Date**: YYYY-MM-DD
```

## assumptions.md

Each entry follows this format:

```markdown
## Assumption A-001

**Statement**: Clear assumption statement
**Reason**: Why this assumption exists
**Impact if false**: What breaks if this is wrong
**Status**: active | validated | invalidated | superseded
**Date**: YYYY-MM-DD
```

# Human-Facing Output Convention

If you show workspace status to humans, bilingual labels are allowed:
- `Task ID / Идентификатор задачи`
- `Decision log / Журнал решений`
- `Questions log / Журнал вопросов`
- `Assumptions / Допущения`
- `Traceability / Трассируемость`

Core instructions remain English-only.

# Hard Rules

1. Task artifacts must remain task-scoped.
2. Workspace hygiene is part of the spec process, not an optional extra.
3. Never silently merge two unrelated tasks into one workspace.
4. If the user explicitly wants a single umbrella spec for multiple subtasks, document that choice in `decision-log.md`.
5. Resolve the active task directory before any write and never modify sibling task workspaces.

## Integration Points

| Agent / System | Interaction |
|---|---|
| **Kanban** | Mirror progress and blockers, but workspace files are source of truth |
| **Implementation agents** | Read spec.md and decision-log.md |
| **Review agents** | Check traceability.md and assumptions.md |
| **QA** | Derive test cases from spec.md and traceability.md |
