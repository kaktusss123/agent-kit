---
name: codebase-design
description: "Design or improve module boundaries, interfaces, ownership, state, and test seams for a concrete repository change."
---

# Codebase design

Prefer a small interface that hides substantial behavior and keeps related knowledge local.

Ask whether callers can know less, whether state ownership is obvious, and whether a proposed abstraction represents real variation or only hypothetical flexibility.

For a costly structural decision, sketch two meaningfully different whole designs before choosing. Compare coupling, locality, failure behavior, compatibility, testability, and migration cost.

Fit the existing repository unless the task explicitly requires changing its architecture.
