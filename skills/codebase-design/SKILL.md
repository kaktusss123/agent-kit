---
name: codebase-design
description: "Design or improve module boundaries, interfaces, ownership, domain types, and test seams. Use for architecture work, API/module reshaping, refactoring that changes structure, or when an agent must compare alternative designs and prefer a small interface that hides complexity and keeps knowledge local."
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

## Design it twice when it matters

For a costly or hard-to-reverse structural choice, sketch at least two meaningfully different whole shapes before committing. Compare interface depth, locality, state ownership, failure behavior, and migration cost.

Do not perform multi-model orchestration unless the surrounding environment explicitly chooses to.
