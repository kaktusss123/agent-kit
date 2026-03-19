# Kanban-First Agentic Workflow Architecture

## Goal

Replace ad hoc and task-file-heavy execution with a kanban-first workflow where:

- `kanban` stores task state, decisions, blockers, verification, and review outcome
- `CodeGraphContext` informs impact analysis and non-trivial review
- orchestration lives behind a dedicated primary agent
- legacy agents continue to work without being forced into the new workflow

## Entry Point

The new workflow is entered through:

- primary agent `openagent-orchestrator`
- command `command/agentic-workflow.md`

This keeps the new process opt-in while migration is in progress.

## Primary Agent Model

`openagent-orchestrator` is a disciplined process manager, not a general coder.

Its responsibilities are:

- create or update kanban items
- enforce stage order
- delegate to hidden workflow subagents
- refuse implementation before required gates pass
- refuse commit flow without verification and review

## Hidden Workflow Subagents

| Subagent | Role | MCP Access |
|----------|------|------------|
| `feature-triager` | Frame scope, risk, acceptance criteria | `kanban` |
| `graph-impact-analyst` | Analyze direct and indirect impact | `kanban`, `CodeGraphContext` |
| `design-planner` | Produce design brief and execution plan | `kanban` |
| `implementer` | Execute scoped changes | `kanban`, `CodeGraphContext` |
| `verification-engineer` | Produce verification summary | `kanban` |
| `reviewer-against-plan` | Review against intent and actual impact | `kanban`, `CodeGraphContext` |

## Workflow Stages

1. **Triage** - Clarify objective, scope, assumptions, acceptance criteria
2. **Impact Analysis** - Determine direct and indirect blast radius
3. **Design Brief** - Compare options and define the intended approach
4. **Execution Plan** - Order steps, checks, and definition of done
5. **Implementation** - Make scoped changes only
6. **Verification** - Run checks and summarize residual risk
7. **Review** - Compare actual work against the plan and impact report
8. **Commit Readiness** - Confirm all gates passed before commit handoff

## Workflow Skills

The orchestrator workflow uses dedicated skills:

- `workflow-gates`
- `kanban-discipline`
- `codegraph-impact-analysis`
- `design-brief`
- `execution-plan`
- `replan-on-surprise`
- `verification-gate`
- `review-against-plan`
- `commit-readiness`
- `decision-log`

Each skill owns a focused rule set plus `references/domain-knowledge.md` for durable details.

## Isolation Strategy

The new workflow is isolated by:

- hiding workflow subagents from normal autocomplete
- denying workflow subagents to other agents via `permission.task`
- denying workflow-only skills to other agents via `permission.skill`
- granting MCP access to new subagents based on role, not globally

Legacy agents keep their existing behavior and are not forced into kanban-first execution.

## Source Of Truth Rules

- `kanban` is the process source of truth
- chat is never the durable source of truth
- `.tmp/tasks` and TaskManager are not part of the new workflow path

## Current Migration State

- Orchestrator entrypoint exists
- Hidden workflow subagents exist
- Workflow skills exist
- Legacy agents remain active
- Cleanup of unused skill scaffolding is deferred until workflow validation completes

## Related Files

- `agent/core/openagent-orchestrator.md`
- `command/agentic-workflow.md`
- `opencode.json`
