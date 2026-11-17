---
name: code-review
description: "Review a proposed or implemented change against two independent questions: does it satisfy the intended spec/request, and is the engineering sound for the repository. Use when: reviewing a diff or PR/MR; verifying a committed checkpoint in a fresh context; running a bounded review-loop; orchestrating independent review with assigned lenses. Not for: repairing the change in the same pass; use skill://git-task for repair routing."
---

# Code review

Review the actual diff against a fixed base when possible.

## Base and verdict

Review the actual diff against a fixed base, not the change in isolation.

- A `PASS` that precedes merge must be computed against the base the commit will land on. Re-check when the base moved.
- A review of only the delta since the previous candidate may not return plain `PASS`; it returns `PASS (delta only, base interaction unverified)`.

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

For a `PASS` that depends on lifecycle, concurrency, ordering, or recovery behavior, cite at least one executed check: a focused test, a repro script, or a real call. If no such check ran, the verdict is `PASS (static only)`.

Use specialized skills such as `skill://blast-radius` for non-obvious downstream risk when warranted.

## Optional review-loop

For an explicitly requested iterative independent review, read `references/review-loop.md`. A normal review remains a single pass; a council participant performs one assigned assessment, not a nested loop.

## Optional adversarial replay

When a suspicious path merits more evidence, try a focused reproduction or independent replay against the exact base and candidate revisions, with stated inputs, assumptions and observable outcome. Include a control when useful. An independent replay should not inherit the author's expected result as its oracle. Report whether the behavior was reproduced, refuted, blocked or not attempted, and preserve the evidence.

A concrete static finding with a demonstrated mechanism remains a finding even if a cheap runtime reproduction is unavailable. An unverified hypothesis is not a proven defect; label the uncertainty. Review is read-only and does not authorize product repair. If a reproduction requires writes, use an explicitly authorized isolated destination or managed candidate lane with its own owner; never write into the primary checkout or concurrently into the reviewed worktree. Do not require a fixed number of reviewers.

## Checkpoint verification mode

Use this mode for fresh-context verification of a committed checkpoint, typically a candidate commit from an owner or a development slice. Do not also implement or repair it.

Inputs:
- the commit or exact diff being verified and its base;
- the slice request, specification, or acceptance criteria;
- material repository conventions or policies that govern the change.

Rules:
- Treat the implementation as a claim, not as something to defend. The repository, diff, and executable evidence outrank the implementer's summary.
- Do not repair the checkpoint in the same pass. Repair is a new task or owner that first inspects current state.
- Use `skill://verification-design` to choose the smallest checks that can observe the requested behavior.
- If the intended behavior is genuinely unavailable, report a blocker instead of inventing a contract.
- Return the output contract below; a checkpoint verdict uses `PASS` or `FAIL` with the same evidence rules.

## Lenses

This section is the single registry of code-review lenses. Review orchestration should load this skill to discover the current lenses instead of maintaining a separate catalog.

- `contracts`: use for API, schema, persistence, serialization, protocol, or compatibility changes. Read `references/contracts.md`.
- `tests`: use when behavior changed, tests changed, or regression evidence matters. Read `references/tests.md`.
- `performance`: use for hot paths, I/O, allocation, concurrency, algorithms, or scale-sensitive changes. Read `references/performance.md`.
- `complexity`: use when the solution adds material structure, indirection, state, or coupling. Read `references/complexity.md`.

If the caller assigned lenses, apply those lenses and load their references. If no lenses were assigned, choose only those triggered by the change. Assigned lenses focus additional attention; they never forbid reporting an obvious blocking defect outside their scope.

## Findings

Separate blocking correctness/contract issues from maintainability suggestions. Give a concrete mechanism and evidence. Do not manufacture findings to make a review look thorough.

If correctness rests on an ordering, timing, or lifecycle assumption, name the assumption and state whether it was observed in the real runtime, a product test, or only a fixture. Fixture-only evidence is not proof.

When `skill://blast-radius` was used, reference its result from the finding that depends on it.

Flag dangling references: citations in committed code, comments, or docs that do not resolve to a tracked repo-local path, ADR, or explicit versioned upstream URL (authoring rule: `skill://skill-design`).

Do not auto-apply fixes unless asked. Do not require multiple reviewers or models. The environment may add independent reviewers later without changing this review contract.

## Output

The first line is exactly one of:

- `PASS`
- `FAIL`
- `PASS (static only)`
- `PASS (delta only, base interaction unverified)` for the delta-only case in **Base and verdict**.

`FAIL` requires at least one blocking finding.

Then:
- findings, one per line: `F<n> [P0|P1|P2] file:line — mechanism — evidence`;
- a labelled `Intent:` block and a labelled `Engineering:` block. If no contract was supplied, write `Intent: not assessable (no contract supplied)`.
