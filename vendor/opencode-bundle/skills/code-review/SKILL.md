---
name: code-review
description: "Review a code checkpoint for requested behavior and engineering soundness. Use directly for code review, or as the single registry of code-review lenses when another agent is organizing independent review. Callers may assign one or more lenses; when none are assigned, select the lenses triggered by the change."
---

# Code review

Review the requested behavior and engineering quality separately so one cannot hide failure in the other.

Always inspect the diff and enough surrounding code to judge correctness, integration risk, repository invariants, and failure behavior. Assigned lenses focus additional attention; they never forbid reporting an obvious blocking defect outside their scope.

## Lenses

This section is the single registry of code-review lenses. Review orchestration should load this skill to discover the current lenses instead of maintaining a separate catalog.

- `contracts`: use for API, schema, persistence, serialization, protocol, or compatibility changes. Read `references/contracts.md`.
- `tests`: use when behavior changed, tests changed, or regression evidence matters. Read `references/tests.md`.
- `performance`: use for hot paths, I/O, allocation, concurrency, algorithms, or scale-sensitive changes. Read `references/performance.md`.
- `complexity`: use when the solution adds material structure, indirection, state, or coupling. Read `references/complexity.md`.

If the caller assigned lenses, apply those lenses and load their references. If no lenses were assigned, choose only those triggered by the change.

Do not create findings to fill categories. Every blocking finding needs concrete evidence and a reason it matters.
