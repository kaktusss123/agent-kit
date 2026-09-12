---
name: prototype
description: "Build a disposable experiment to answer a concrete uncertain engineering question before committing to architecture or implementation. Use when a small runnable spike can settle API feasibility, framework behavior, UX mechanics, performance shape, integration assumptions, or competing design options faster than more discussion."
---

# Prototype

A prototype answers a question. It is not early production code.

## Define the question first

Write a falsifiable question and success/failure observation. Examples:
- Does this installed API support changing cwd during a new session?
- Can two processes use separate state dirs concurrently?
- Does this serialization preserve ordering across versions?

## Keep it disposable

Use the smallest environment that still exercises the uncertain boundary. Avoid production abstractions, migrations, broad cleanup, or polish.

Run the experiment and capture the observation. If results are ambiguous, tighten the experiment rather than arguing from it.

## Afterward

Translate the finding into a design constraint or decision. Delete the prototype unless it remains valuable as a regression/diagnostic tool, in which case rename and document it as such.

Do not let prototype structure silently become production architecture.
