---
name: specification
description: "Turn established intent, evidence, and decisions into a semantic implementation specification. Use in ordinary planning, plan mode, tickets, or task workflows when work needs a durable contract that explains desired behavior, constraints, decisions, acceptance scenarios, testing seams, non-goals, and risks without overfitting to temporary file paths or code snippets."
---

# Specification

Write the contract another capable engineer can implement without inheriting the conversation.

## Before writing

Do not use the spec to hide unresolved decisions. If material intent is ambiguous, use `skill://grilling` first.

Ground claims about existing behavior in repository evidence or authoritative external sources. Keep facts separate from decisions.

## Required content

Include the sections that materially apply:

- Problem and desired outcome
- Observable behavior
- Constraints and invariants
- Confirmed decisions and rationale
- Implementation decisions that are part of the contract
- External/public contracts and compatibility requirements
- Testing or verification seams
- Acceptance scenarios, including meaningful failure paths
- Out of scope
- Residual risks or explicitly unresolved items

Keep small work small. Do not create empty sections for dimensions that do not matter.

## Semantic, not brittle

Prefer stable meaning over an implementation transcript.

Avoid exact file paths, class names, command sequences, or code snippets when they merely describe today's likely implementation. Include them when the exact artifact is itself part of the contract, such as a public schema, generated filename, CLI surface, migration file, or required integration point.

A prototype may contribute a compact type/state-machine/schema fragment when prose would lose a real decision. Do not paste a working implementation into the spec.

## Acceptance quality

Acceptance scenarios must be observable and falsifiable. Describe what input or event occurs, what the user/system observes, and important failure behavior.

Do not substitute "tests pass" for acceptance criteria.
