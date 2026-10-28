---
name: skill-design
description: "Design, refactor, and prune agent skills, role prompts, AGENTS-style guidance, and reusable workflow instructions. Use when: creating or improving a skill; auditing a skill portfolio for dead, overlapping, or never-firing descriptions; deciding whether a new skill is justified; separating generic capabilities from workflow adapters and reducing context load. Not for: designing product architecture; use skill://simple-design."
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

Apply the shared invariant from `rules/AGENTS.md` at authoring time: keep the
main SKILL.md self-contained (state the invariant inline) and link only
tracked repo-local paths or versioned upstream URLs. Skill-specific review
of dangling references lives in `skill://code-review`.

Test skills on real sessions and revise from observed failure, not aesthetic preference.
