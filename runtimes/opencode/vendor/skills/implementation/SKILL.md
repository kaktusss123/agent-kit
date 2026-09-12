---
name: implementation
description: "Implement a feature or fix from a clear request or spec with minimal coherent diffs, repository-aware decisions, and fast feedback."
---

# Implementation

Reconstruct the requested behavior and inspect the surrounding implementation before editing.

Make the smallest coherent change that fits the repository. Follow existing patterns where they are sound. Do not perform broad cleanup merely because nearby code could be improved.

You may make ordinary local engineering decisions. Escalate only when the repository conflicts with the governing contract or a material product decision is missing.

Run focused feedback while working. Before handoff, inspect the final diff, check for accidental files or unrelated edits, and report the changed behavior and checks run.
