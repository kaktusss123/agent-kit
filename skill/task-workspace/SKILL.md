---
name: task-workspace
description: >
  Initializes and maintains a task-scoped specification workspace for a single
  feature or change request. Ensures that logs and artifacts are isolated per task.
---

# Purpose

Create and maintain a dedicated workspace for each specification task so that
questions, decisions, assumptions, and generated artifacts do not overwrite each other across tasks.

# Workspace Layout

Each task must use:

`specs/<task-id>/`

Minimum files:
- `spec.md`
- `decision-log.md`
- `questions-log.md`
- `repo-scout.md`
- `assumptions.md`
- `traceability.md`

# Task ID Rules

Prefer, in order:
1. issue/ticket key if provided,
2. explicit task identifier from the user,
3. stable slug derived from the task title.

Task IDs should be concise, human-readable, and stable.

# File Responsibilities

## spec.md
The current implementation-ready specification.

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

# When to Initialize

Initialize a workspace:
- at the first serious intake of a new feature/change request,
- before deep clarification begins,
- before repository scouting output is stored.

# Initialization Checklist

For a new task:
1. determine `<task-id>`;
2. ensure `specs/<task-id>/` exists;
3. initialize the minimum artifact files if missing;
4. record the original request in `questions-log.md`;
5. initialize empty or skeletal sections in the other files as needed.

# Suggested Initial File Skeletons

## `decision-log.md`

Use a structure like:

- `Decision ID`
- `Status`
- `Decision`
- `Rationale`
- `Alternatives considered`
- `Consequences`

## `questions-log.md`

Use a structure like:

- `Question ID`
- `Category`
- `Why it matters`
- `Question`
- `Answer`
- `Resolution status`

## `assumptions.md`

Use a structure like:

- `Assumption ID`
- `Statement`
- `Reason`
- `Impact if false`
- `Status`

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