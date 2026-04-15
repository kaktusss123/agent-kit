# Workflow Gates Knowledge

## Required Stages

- **Triage** frames objective, scope, assumptions, and acceptance criteria.
- **Impact analysis** is required before non-trivial implementation.
- **Design brief** is required for medium or high risk tasks.
- **Execution plan** is required before implementation starts.
- **Commit** follows every `implementer` pass that changes files.
- **Verification** runs against the latest implementation commit.
- **Review** runs against the latest implementation commit.
- **Fixes** that change files repeat the implement -> commit -> verify/review loop.

## Selection Rules

- Skip directly to implementation only for obvious low-risk local edits.
- Treat API, schema, auth, shared library, and multi-file changes as non-trivial.
- If an implementation pass changes no files, the loop can stop without commit.
- If uncertainty changes architecture or scope, re-enter planning instead of continuing.

## Failure Rule

- Missing prior gate evidence blocks the next stage.
