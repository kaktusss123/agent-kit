# Kanban-First Agentic Workflow Architecture

## Goal

Replace ad hoc and task-file-heavy execution with a kanban-first workflow where:

- `kanban` stores task state, decisions, blockers, verification, and review outcome
- `CodeGraphContext` informs impact analysis and non-trivial review
- orchestration lives behind a dedicated primary agent
- legacy agents continue to work without being forced into the new workflow

## Entry Point

The new workflow is entered through:

- primary agent `fast-spec-analyst` for straightforward requirements discovery
- primary agent `full-spec-analyst` for comprehensive specification discovery
- primary agent `openagent-orchestrator`
- command `command/spec-discovery.md` (launches `full-spec-analyst`)
- command `command/agentic-workflow.md`

This keeps the new process opt-in while migration is in progress.

The dedicated review entrypoint is `command/review.md`.

When a task starts ambiguous, discovery should happen in `fast-spec-analyst` (for straightforward features) or `full-spec-analyst` (for complex features) before orchestration begins.

## Primary Agent Model

`openagent-orchestrator` is a disciplined process manager, not a general coder.

`fast-spec-analyst` is the lightweight requirements analyst for straightforward features.
`full-spec-analyst` is the comprehensive specification discovery agent for complex features.

Primary responsibilities:

- `fast-spec-analyst` interrogates straightforward requests through focused interview loops
- `fast-spec-analyst` produces a single-file handoff-ready spec in `docs/specs/<slug>.md`
- `full-spec-analyst` orchestrates comprehensive discovery through specialized subagents
- `full-spec-analyst` produces a workspace-based spec in `docs/specs/<task-id>/` with full traceability
- Both spec analysts stop before coding when requirements are still incomplete
- Both spec analysts ask blocking questions in chat before writing the spec artifact
- `openagent-orchestrator` creates or updates kanban items
- `openagent-orchestrator` enforces stage order
- `openagent-orchestrator` delegates to hidden workflow subagents
- `openagent-orchestrator` refuses implementation before required gates pass
- `openagent-orchestrator` refuses commit flow without verification and review

## Hidden Workflow Subagents

| Subagent | Role | MCP Access |
|----------|------|------------|
| `feature-triager` | Frame scope, risk, acceptance criteria | `kanban` |
| `graph-impact-analyst` | Analyze direct and indirect impact | `kanban`, `CodeGraphContext` |
| `design-planner` | Produce design brief and execution plan | `kanban` |
| `implementer` | Execute scoped changes | `kanban`, `CodeGraphContext` |
| `verification-engineer` | Produce verification summary | `kanban` |
| `helper-gpt54` | Escalation helper for debugging and test failures | none |
| `helper-opus` | Escalation helper for architecture and deep diagnosis | `CodeGraphContext` |
| `reviewer-minimax` | Medium-depth broad implementation review | none |
| `reviewer-google` | Medium-depth code and edge-case review | none |
| `reviewer-against-plan` | Request, ADR, and execution-plan alignment review | none |
| `reviewer-deep` | Deep correctness and architecture review | `CodeGraphContext` |
| `reviewer-security` | Security-focused review | `CodeGraphContext` |

### Review Model Split

| Reviewer | Model | Purpose |
|----------|-------|---------|
| `reviewer-minimax` | `cloudru/MiniMaxAI/MiniMax-M2` | Broad medium-depth implementation review |
| `reviewer-google` | `google/gemini-3.1-pro-preview` | Code-centric logic and edge-case review |
| `reviewer-against-plan` | `cloudru/MiniMaxAI/MiniMax-M2` | Intent and plan alignment review |
| `reviewer-deep` | `anthropic/claude-opus-4-6` | Deep correctness and architecture review |
| `reviewer-security` | `openai/gpt-5.4` | Security and trust-boundary review |

All review subagents are read-only, may read the repository for context, and may use only allowlisted `rtk git` inspection commands for scope-aware review.

## Workflow Stages

0. **Spec Discovery** - Interrogate requirements, inspect context, and write a handoff-ready spec when ambiguity is high
1. **Triage** - Clarify objective, scope, assumptions, acceptance criteria
2. **Impact Analysis** - Determine direct and indirect blast radius
3. **Design Brief** - Compare options and define the intended approach
4. **Execution Plan** - Order steps, checks, and definition of done
5. **Implementation** - Make scoped changes only
6. **Verification** - Run checks and summarize residual risk
7. **Review** - Fan out parallel reviewers, then aggregate findings into one verdict
8. **Commit Readiness** - Confirm all gates passed before commit handoff
9. **Await Approval** - After commit, wait for the user's approval before continuing unless the prompt explicitly waives it

## Discovery Gate Heuristics

The orchestrator should stop and gather answers before implementation when any of these are true:

- the repository is empty or nearly empty
- the task is greenfield product work rather than a local patch
- screenshots, mockups, or reference designs define the UX
- an external backend, API, or sibling repository defines key behavior
- acceptance criteria are not yet testable

In those cases, use discovery-first behavior instead of treating the prompt as implementation-ready.

`fast-spec-analyst` should use a chat-first interview loop: inspect context, ask a small batch of blocking questions, wait for answers, repeat if needed, then write the spec once the ambiguity is reduced enough for a stable artifact.

`full-spec-analyst` should orchestrate comprehensive discovery: delegate to `repo-scout` for repository analysis, `feature-triager` for structured clarification, specialized analysis subagents (`edge-case-harvester`, `contract-impact-auditor`, `non-functional-prober`), and `traceability-checker` for completeness verification.

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

## Parallel Review Model

The orchestrator should run the review stage as a parallel fan-out:

- `reviewer-minimax` for broad medium-depth findings
- `reviewer-google` for code-path and edge-case findings
- `reviewer-against-plan` for request, ADR, and plan drift
- `reviewer-deep` for deep correctness and architecture fit
- `reviewer-security` for concrete security concerns

The reviewers must stay read-only and return findings to the orchestrator.
Only the orchestrator aggregates the results and records the final review outcome in `kanban`.

## Default Operating Mode

Unless the task prompt explicitly says otherwise, the orchestrator should operate in this sequence:

1. analyze
2. implement
3. review
4. commit
5. await user approval

If the current request explicitly says to stop before commit, the orchestrator should stop at commit-ready and wait for approval.

Remote git operations such as `push` or PR creation are outside this default mode and require explicit user authorization.

## Escalation Helpers

When cheaper agents get stuck, the orchestrator should use controlled escalation instead of letting them loop forever.

### Helper Roles

| Helper | Model | Use First For |
|--------|-------|---------------|
| `helper-gpt54` | `openai/gpt-5.4` | failing tests, debugging, concrete implementation blockers, security-sensitive bug diagnosis |
| `helper-opus` | `anthropic/claude-opus-4-6` | architecture ambiguity, hidden coupling, replan, deep root-cause analysis |

### Escalation Threshold

- Escalate after 5 attempts against the same failure signature without meaningful progress.

### Ownership Rule

- Helpers are advisory by default.
- The original agent keeps ownership.
- The orchestrator returns helper output back to the original agent unless it explicitly switches to takeover mode.

### Fallback Rule

1. Use the best-fit helper first.
2. If it is unavailable, use the other helper.
3. If both are unavailable, return to the original agent with a `helpers_unavailable` note.
4. Allow at most 2 additional local attempts with a new strategy.
5. If still blocked, stop and wait for user approval.

## Review Scope Sources

The orchestrator should support review of:

- uncommitted worktree changes
- current state relative to `origin/develop`
- a specific commit

If no scope is provided, default to uncommitted worktree changes.

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
