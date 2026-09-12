---
name: system-understanding
description: "Trace how an existing subsystem actually works before designing, debugging, or modifying it."
---

# System understanding

Build a causal model, not a file list.

Find the entry point, then trace control flow, data flow, state ownership, external boundaries, side effects, failure paths, and the tests that observe the behavior. Look for analogous implementations nearby before inventing a new pattern.

Return only the evidence needed for the task: relevant paths and symbols, how the path works, important invariants, and unresolved questions.
