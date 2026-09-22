---
name: codebase-design
description: "Decide where responsibility, state, and interfaces live once the functionality itself is justified: module boundaries, interfaces, ownership, domain types, test seams, refactoring that changes structure. The prior question — whether the complexity is needed at all — belongs to skill://simple-design."
---

# Codebase design

Design deep modules: substantial behavior behind a small interface at a clean seam.

## Vocabulary

- **Module**: an implementation presented through an interface.
- **Interface**: everything callers must know, including invariants and failure modes.
- **Seam**: a place where behavior can vary or be replaced without editing callers.
- **Adapter**: an implementation occupying a seam.
- **Depth**: useful capability hidden behind a relatively small interface.
- **Locality**: how much related knowledge and change stay together.

## Design tests

Ask:
- Can callers know less?
- Can fewer methods or parameters expose the same capability?
- Does this seam correspond to real variation or only hypothetical flexibility?
- If this module vanished, would its complexity disappear or leak back into many callers?
- Can behavior be verified through the same interface callers use?
- Is state ownership obvious?

Prefer dependencies passed across explicit seams over hidden construction when replaceability or testing requires it. Do not create interfaces for a single implementation without a real boundary reason.

## State and boundaries

- Model important states explicitly. Make invalid states hard to represent.
- Validate raw input at system boundaries, then trust typed internal state. Keep policy at the boundary and core logic testable without framework plumbing.
- Before sharing mutable state between actors, ask whether either can change it independently; isolate first when possible.
- Design retries and partial failures so rerunning an operation converges instead of compounding damage.
- Consolidate a decision in one place instead of threading the same choice through many layers. If a maintainer must trace many wrappers to answer a simple question, flatten it.

## Design it twice when it matters

For a costly or hard-to-reverse structural choice, sketch at least two meaningfully different whole shapes before committing. Compare interface depth, locality, state ownership, failure behavior, and migration cost.
