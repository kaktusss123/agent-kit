---
description: Run a task through the kanban-first orchestrator workflow
agent: openagent-orchestrator
---

Use the kanban-first orchestrator workflow for this task:

$ARGUMENTS

Keep legacy agents as compatibility paths, but route this request through the new orchestrator, hidden workflow subagents, kanban discipline, and gated verification flow.

Default mode is `analyze -> implement -> review -> commit -> await my approval` unless the prompt explicitly waives my approval or authorizes moving to the next feature automatically.
