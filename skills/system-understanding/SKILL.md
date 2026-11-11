---
name: system-understanding
description: "Use when: tracing current software behavior, data/control flow, or state ownership, including read-only investigations. Not for: analyzing development practice or session statistics, or explaining historical design decisions."
---

# System understanding

Build a causal model, not a file list.

## Trace the behavior

Start from the user-visible or external entry point relevant to the question and follow the real path through the system.

Capture only what matters to that path:
- inputs and callers;
- control flow and important branches;
- data transformations and persisted/shared state;
- ownership and lifecycle of state;
- external interfaces and adapters;
- errors, retries, cleanup, and recovery;
- tests or scripts that demonstrate the behavior.

Use exact symbols and paths as evidence, but summarize the model in system terms.

## Distinguish evidence

Label uncertainty. Source code and executable behavior outrank stale prose about current behavior. Documentation and ADRs remain authoritative for intended constraints and rationale when they are current.

If docs and code disagree, preserve the disagreement instead of silently choosing whichever is convenient.

## Output

Return a compact traced model plus:
- established facts;
- assumptions/inferences;
- important unknowns;
- likely change seams if the user is considering a modification.
