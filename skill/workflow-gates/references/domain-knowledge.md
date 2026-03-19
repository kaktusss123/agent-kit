# Workflow Gates Knowledge

## Required Stages

- **Triage** frames objective, scope, assumptions, and acceptance criteria.
- **Impact analysis** is required before non-trivial implementation.
- **Design brief** is required for medium or high risk tasks.
- **Execution plan** is required before implementation starts.
- **Verification** must pass before review.
- **Review** must pass before commit readiness.

## Selection Rules

- Skip directly to implementation only for obvious low-risk local edits.
- Treat API, schema, auth, shared library, and multi-file changes as non-trivial.
- If uncertainty changes architecture or scope, re-enter planning instead of continuing.

## Failure Rule

- Missing prior gate evidence blocks the next stage.
