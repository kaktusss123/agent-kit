---
name: system-understanding
description: "Trace how an existing subsystem actually works before designing or modifying it. Use in ordinary chat, plan mode, debugging, architecture work, or task discovery when file-name reconnaissance is insufficient and the agent needs a causal model of entry points, data/control flow, state ownership, contracts, side effects, failure paths, and tests."
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
