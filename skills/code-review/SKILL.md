---
name: code-review
description: "Review a proposed or implemented change against two independent questions: does it satisfy the intended spec/request, and is the engineering sound for the repository. Use directly for code review, or as the single registry of code-review lenses when another agent is organizing independent review; callers may assign one or more lenses. Keep contract fidelity separate from engineering quality so one cannot hide failure in the other."
---

# Code review

Review the actual diff against a fixed base when possible.

## Axis 1: intent and spec

Check:
- required behavior missing or partial;
- behavior that contradicts confirmed decisions;
- unjustified scope expansion;
- acceptance/failure scenarios not implemented;
- silent semantic changes outside the request.

Cite the requirement or decision for each finding.

## Axis 2: engineering

Check the changed code and necessary surrounding context for:
- correctness and failure paths;
- ownership and dependency direction;
- unnecessary complexity or abstractions;
- compatibility/migration concerns;
- state/retry/recovery issues;
- test quality and verification gaps;
- repository-specific documented standards.

Use specialized skills such as `skill://blast-radius` for non-obvious downstream risk when warranted.

## Lenses

This section is the single registry of code-review lenses. Review orchestration should load this skill to discover the current lenses instead of maintaining a separate catalog.

- `contracts`: use for API, schema, persistence, serialization, protocol, or compatibility changes. Read `references/contracts.md`.
- `tests`: use when behavior changed, tests changed, or regression evidence matters. Read `references/tests.md`.
- `performance`: use for hot paths, I/O, allocation, concurrency, algorithms, or scale-sensitive changes. Read `references/performance.md`.
- `complexity`: use when the solution adds material structure, indirection, state, or coupling. Read `references/complexity.md`.

If the caller assigned lenses, apply those lenses and load their references. If no lenses were assigned, choose only those triggered by the change. Assigned lenses focus additional attention; they never forbid reporting an obvious blocking defect outside their scope.

## Findings

Separate blocking correctness/contract issues from maintainability suggestions. Give a concrete mechanism and evidence. Do not manufacture findings to make a review look thorough.
Flag dangling references: citations in committed code, comments, or docs that do not resolve to a tracked repo-local path, ADR, or explicit versioned upstream URL (authoring rule: `skill://skill-design`).

Do not auto-apply fixes unless asked. Do not require multiple reviewers or models. The environment may add independent reviewers later without changing this review contract.
