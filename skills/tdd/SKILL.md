---
name: tdd
description: "Behavior-first test-driven development for features and bug fixes where a useful test seam exists. Use when red-green work will clarify behavior, protect a regression, or guide a vertical slice. Avoid implementation-coupled tests, tautological assertions, and bulk horizontal test writing."
---

# TDD

Use a red to green loop at a behavior seam.

## Choose the seam

Prefer the highest practical public interface that observes the behavior without depending on implementation details. Use existing project seams before inventing new ones.

In a task workflow (`skill://git-task`), use the seams already agreed in the frozen spec unless repository reality proves them invalid. In ordinary chat, discuss a materially new seam if it changes architecture or scope.

## Vertical loop

For each slice:
1. Write one test that expresses one observable behavior.
2. Run it and confirm it fails for the intended reason.
3. Write only enough production code to make it pass.
4. Run the focused test and relevant fast checks.
5. Continue based on what the slice taught you.

Do not write a whole speculative test suite before implementation.

## Test quality

Avoid tests that:
- mock internal collaborators so heavily they merely mirror implementation;
- assert private methods or incidental call ordering;
- recompute expected values with the same algorithm as production;
- pass even if the requested behavior is absent.

A good regression test fails on the original bug and survives internal refactoring that preserves behavior.
