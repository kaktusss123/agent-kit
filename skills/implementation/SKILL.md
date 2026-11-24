---
name: implementation
description: "Use when: implementing a code change from a request or spec, including delegated work; load before the first edit. Not for: only researching, designing, reviewing, or editing prose."
---

# Implementation

Implement the intended behavior against the real codebase, not a remembered plan of the codebase. In a task workflow (`skill://git-task`), a RepoOwner loads this before the first edit.

## Start grounded

Before editing:
- read the governing request/spec and relevant decisions;
- inspect the actual code and repository conventions around the change;
- identify the closest useful verification feedback loop;
- note any semantic conflict before writing around it.

A plan is authority for intent. It is not infallible evidence about current implementation mechanics.

## Change one coherent slice at a time

- Establish a known baseline and continue only from a repository state you understand.
- Prefer the smallest vertical slice that produces observable progress.
- Before adding an abstraction or a parallel implementation, check whether reusing, simplifying, or removing existing code would meet the requirement while preserving required behavior. Justify each new concept with a current requirement or an observed constraint.
- Avoid unrelated refactoring and parallel implementations.
- Keep diffs easy to explain causally.
- Run focused formatter, lint, type, test, or repro feedback while working when it can catch the current class of mistake.

Use `skill://tdd` when a useful behavioral seam exists and test-first work will clarify the change. Do not force TDD on generated/config-only work where another deterministic loop is stronger.

For a hard bug or performance regression, use `skill://diagnosing-bugs` instead of improvising a theory-first repair.

## Handle conflicts explicitly

Stop and surface a conflict when implementation reveals that the requested behavior is impossible, contradictory, materially incomplete, or has multiple externally different resolutions.

Choose ordinary local engineering details yourself when they do not change the agreed contract.

## Finish with evidence

Run the checks that can observe the change and inspect the final diff. In the handoff, summarize the outcome and tie each material acceptance claim to a named check and its observed result. Flag unverified claims and any remaining risk that requires a human decision.
