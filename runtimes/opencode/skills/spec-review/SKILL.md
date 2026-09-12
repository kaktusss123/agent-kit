---
name: spec-review
description: "Review a specification or design artifact for coherence, traceability, completeness, implementability, and verifiability. Use directly for specification review, or as the single registry of spec-review lenses when another agent is organizing independent review. Callers may assign one or more lenses; when none are assigned, select the lenses triggered by the artifact."
---

# Spec review

Review the durable artifact against its governing intent and available repository evidence. Look for contradictions, missing material decisions, unsupported assumptions, and requirements that would force an implementer to invent product behavior.

Assigned lenses focus additional attention; they never forbid reporting an obvious blocking defect outside their scope.

## Lenses

This section is the single registry of specification-review lenses. Review orchestration should load this skill to discover the current lenses instead of maintaining a separate catalog.

- `traceability`: use when requirements, decisions, acceptance criteria, and verification need to line up. Read `references/traceability.md`.
- `completeness`: use when missing behavior, failure paths, boundaries, lifecycle cases, or unresolved decisions could make the spec unsafe to execute. Read `references/completeness.md`.
- `implementability`: use when the spec must be executable by a clean implementation session without inventing architecture or product decisions. Read `references/implementability.md`.
- `verification`: use when acceptance criteria and proposed checks must actually prove the requested behavior. Read `references/verification.md`.

If the caller assigned lenses, apply those lenses and load their references. If no lenses were assigned, choose only those triggered by the artifact.

Do not demand ceremony for its own sake. A small, clear spec can pass without matrices, exhaustive sections, or speculative edge cases.
