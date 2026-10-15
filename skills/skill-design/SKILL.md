---
name: skill-design
description: "Design, refactor, and prune agent skills, role prompts, AGENTS-style guidance, and reusable workflow instructions. Use when creating or improving agent skills or any document consumed by an agent, especially to separate generic capabilities from workflow adapters, reduce context load, sharpen triggers, and keep deterministic policy in code instead of prose."
---

# Skill design

Write instructions that change behavior reliably without becoming a second codebase.

## Separate capability from workflow adapter

Ask first: would this reasoning technique be useful in ordinary chat or another workflow?

If yes, keep it as a standalone generic skill. A workflow role may call or reference it, but must not be the only place the capability exists.

Keep role-specific skills thin. They should describe authority, lifecycle hooks, workflow state, and how generic capabilities bind to runtime tools.

## Put policy in the strongest layer

- deterministic safety, state transitions, schema validation, and completion gates belong in code when possible;
- skills teach judgment, investigation, decision-making, and procedures that require model reasoning;
- do not duplicate a runtime invariant in several prompts unless the model genuinely needs to know it to act correctly.

## Progressive disclosure

The description is a routing pointer. Name distinct trigger branches clearly.

Keep the main SKILL.md focused on the actions every invocation needs. Move large branch-specific reference material behind direct pointers. Do not hide a mandatory step in an obscure reference.

## Completion criteria

Every multi-step procedure should make "done" observable. Prefer exhaustive/checkable criteria over "be thorough".

## Prune

Delete:
- restatements of tool help or obvious model behavior;
- duplicated meanings;
- stale implementation details;
- ceremonial steps that do not change outcomes;
- generic capability text copied into a role adapter.

## Durable references

Committed code, comments, docstrings, tests, and docs must stay meaningful
without access to untracked or private task artifacts: never cite workspace-only
SPECs, bare decision or stage labels (such as `D4` or `R2` without context),
or other references that do not resolve to a tracked repo-local path, an
ADR, or an explicit upstream URL with a version. State the actual
invariant or rationale inline; link a tracked path or anchor only when it
helps. Real upstream documentation and standards with explicit URLs and
versions are fine. Transient discovery IDs belong in task reports, not in
product code. Workspace orchestration itself (task branches, SPEC.md paths in
assignments, ticket identifiers the repo convention uses) is unaffected.

Test skills on real sessions and revise from observed failure, not aesthetic preference.
