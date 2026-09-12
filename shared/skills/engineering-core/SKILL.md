---
name: engineering-core
description: "General engineering discipline for non-trivial software work. Use when designing, implementing, refactoring, migrating, or reviewing code where the agent should prefer the smallest coherent solution, strong boundaries, explicit state, recoverable operations, verifiable increments, and proof from real artifacts rather than self-report."
---

# Engineering core

Use these as defaults, not ceremony.

## Keep the solution small

- Prefer deletion and simplification before adding abstractions.
- Make the smallest coherent change that solves the stated problem.
- Do not add a layer, interface, compatibility path, flag, or framework unless a real boundary or variation requires it.
- Consolidate a decision in one place instead of threading the same choice through many layers.
- If the design makes a maintainer trace many wrappers to answer a simple question, flatten it.

## Get state and boundaries right

- Model important states explicitly. Make invalid states hard to represent.
- Validate raw input at system boundaries, then trust typed internal state.
- Keep policy at the boundary and core logic testable without framework plumbing.
- Before sharing mutable state between actors, ask whether either can change it independently. Isolate first when possible.
- Design retries and partial failures so rerunning an operation converges instead of compounding damage.

## Work in verifiable increments

For non-trivial changes:

1. Establish a known baseline.
2. Make one coherent change.
3. Run the cheapest check that can falsify it.
4. Continue only from a state you understand.

Do not batch many uncertain edits and postpone all feedback to the end.

## Prove the result

Treat summaries and intentions as claims. Inspect the artifact.

Prefer, in order of relevance:
- actual diff and file contents;
- focused tests or scripts that exercise changed behavior;
- build/type/lint checks where they can observe the failure class;
- real user-facing or integration path for claims that require it.

"It compiles" is not proof that a feature works. A passing test is not proof if the test cannot observe the requirement.

## Escalate only real uncertainty

Discover engineering facts from code, docs, tools, and primary sources. Ask the human for decisions that change intent, observable behavior, contracts, risk acceptance, or scope.
