---
name: simple-design
description: Design or simplify software architecture, APIs, modules, workflows, agent systems, refactors, and technical plans with a hard bias toward the smallest sufficient solution. Use when proposing abstractions, orchestration, frameworks, extensibility, state machines, configuration, module boundaries, or any design that risks accumulating speculative machinery or too many moving parts.
---

# Simple Design

Optimize for the smallest design that solves the real current problem and remains easy to understand, inspect, change, and delete.

## Prime directive

Before adding any non-trivial mechanism, abstraction, state, component, layer, or workflow step, ask:

**«А не хуйню ли мы делаем? А не слишком ли сложно выходит?»**

Ask it again whenever the design grows. If the answer might be yes, simplify before proceeding.

## What good looks like

- Solve the stated problem end-to-end, not hypothetical future problems.
- Introduce the fewest new concepts and moving parts needed.
- Prefer an existing primitive or a direct implementation over a new framework.
- Keep important behavior and state explicit, visible, and inspectable.
- Make the common path obvious.
- Preserve changeability through small clean boundaries, not speculative abstraction.
- Let complexity enter only when a concrete requirement, observed failure, or proven constraint demands it.
- Prefer designs that are easy to remove or replace.

Simplicity means low cognitive load, not minimum line count. A small interface that hides necessary complexity can be simpler than compressed or clever code.

## Biases

- YAGNI: do not build capabilities for imagined future use.
- Start simple and evolve from something that already works.
- Prefer clarity over cleverness.
- Separate concerns only when the separation removes real coupling or hides real complexity.
- Prefer simple composable parts over a feature-rich core.
- Keep the core small; move optional or policy-specific behavior outward when multiple real policies exist.
- Prefer explicit files, processes, and direct calls over hidden orchestration and extra state.
- Prefer one concrete implementation over an abstraction with one consumer.
- When uncertain, choose the more reversible design or run a small prototype instead of designing for every possibility.
- Trust capable models and existing tools. Do not encode elaborate procedures, wrappers, or machinery unless observed failures justify them.

## Make complexity earn its existence

Do not add something merely because it might be useful later: plugin systems, registries, factories, adapters, provider layers, extra lifecycle states, metadata, configuration knobs, background coordination, generic frameworks, caching, scaling machinery, or compatibility layers.

None of these are forbidden. Each must solve a concrete problem that exists now.

Keep or add complexity when it is required for correctness, safety, compatibility, concurrency, persistence, operability, or another demonstrated constraint. State that constraint explicitly.

Do not simplify by hiding necessary complexity, deleting safeguards, or making behavior implicit.

## Design response

Lead with the simplest sufficient design. Mention a more elaborate design only when a concrete requirement makes the simple one insufficient.

For every new abstraction or subsystem, be able to answer in one sentence: **what current problem pays for this complexity?** If there is no convincing answer, remove it.
