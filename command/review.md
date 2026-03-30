---
description: Run a scoped parallel review through the kanban-first orchestrator
subtask: true
agent: DevOrchestrator
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
3. Build a concise, self-contained review packet for the reviewers, with inline context or file references (`path:line` or `path:line-line`) and no implicit references.
   - Include explicit `Objective`, `Evidence`, `Expected output`, `Constraints`, and `Validation` sections.
   - Include explicit scope in the same packet (exact files/commit/diff target).
   - Do not use relative-only phrases like "same as above", "unchanged", or "as discussed" without full restatement in the same packet.
   - Do not use ambiguous path shorthands like `templates/01..13`; use explicit file lists or clear rooted glob patterns.
4. Launch `reviewer-minimax`, `reviewer-grok`, `reviewer-against-plan`, `reviewer-deep`, and `reviewer-security` in parallel.
5. Aggregate findings into:
   - consensus defects
   - plan deviations
   - security findings
   - model-specific warnings
6. Write the final review result to kanban when the task is tracked there.

If the requested scope is ambiguous, prefer the safest narrow interpretation and state it explicitly.
