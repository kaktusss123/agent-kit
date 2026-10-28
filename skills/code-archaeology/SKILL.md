---
name: code-archaeology
description: "Investigate why existing code, architecture, or a constraint is shaped the way it is. Use when: a strange design may encode historical intent; a refactor risks deleting a compatibility or operational reason; commits, ADRs, issues, and tests disagree; you need to know whether a constraint still applies before changing behavior. Not for: tracing only current runtime behavior; use skill://system-understanding."
---

# Code archaeology

Answer "why is this here?" with evidence, not folklore.

## Work from the current shape backward

1. Identify the exact surprising behavior, abstraction, invariant, or workaround.
2. Establish what it currently does with source and tests.
3. Read nearby comments, ADRs, design docs, commit history, blame, linked issues/PRs, and migration notes when available.
4. Separate original reason from current reason. A historical constraint may no longer apply, or a once-temporary workaround may now encode compatibility.
5. Look for callers or external contracts that still rely on the shape.

Prefer primary evidence from the repository and authoritative linked systems. Do not invent motivation from naming alone.

## Output

State:
- current purpose;
- strongest evidence for historical rationale;
- which constraints still apply;
- which appear obsolete or uncertain;
- consequence of removing or changing the shape.

If the reason cannot be established, say so. "Unknown" is better than an architectural myth.
