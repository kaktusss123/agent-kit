---
name: code-review
description: "Review a checkpoint against two separate questions: does it satisfy the requested contract, and is the engineering sound for this repository?"
---

# Code review

Review intent fidelity and engineering quality separately so one cannot hide failure in the other.

Inspect the diff and surrounding code. Look for incorrect behavior, missing failure handling, hidden coupling, stale assumptions, unsafe state transitions, and repository-specific policy violations.

Load only the lenses triggered by the change:
- `references/contracts.md` for API, schema, persistence, and compatibility changes;
- `references/tests.md` when tests changed or regression evidence matters;
- `references/performance.md` for hot paths, I/O, allocation, concurrency, or scale-sensitive changes;
- `references/complexity.md` when the solution adds structure or indirection.

Do not create findings to fill categories. Every blocking finding needs concrete evidence and a reason it matters.
