---
description: Run a scoped parallel review through the kanban-first orchestrator
subtask: true
agent: openagent-orchestrator
---

# Review Command

Run a scoped review using the orchestrator and the parallel review mesh.

## Scope Resolution

Interpret `$ARGUMENTS` as the review scope.

Supported forms:

- empty arguments -> review current uncommitted changes
- `develop` -> review current git state relative to `origin/develop`
- `<commit-sha>` -> review a specific commit

## Required Workflow

1. Resolve and state the exact review scope.
2. Gather git evidence for that scope.
3. Build a concise review packet for the reviewers.
4. Launch `reviewer-minimax`, `reviewer-qwen`, `reviewer-against-plan`, `reviewer-deep`, and `reviewer-security` in parallel.
5. Aggregate findings into:
   - consensus defects
   - plan deviations
   - security findings
   - model-specific warnings
6. Write the final review result to kanban when the task is tracked there.

If the requested scope is ambiguous, prefer the safest narrow interpretation and state it explicitly.
