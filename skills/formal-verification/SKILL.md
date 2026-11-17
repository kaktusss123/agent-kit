---
name: formal-verification
description: "Model and check one critical system property against an explicit implementation correspondence. Use when: a bounded formal model can expose concurrency, state, or protocol failures that ordinary tests may miss; maintain an existing model after code changes."
---

# Formal verification

Choose one consequential property and the smallest model that can falsify it. State the property, initial conditions, environment and failure assumptions, bounds and excluded behaviors. Pick a fitting method and available tool: a small state explorer, property-based state machine, SAT/SMT solver or temporal model checker may be appropriate; do not assume TLA+ is always needed.

Map each modeled state, transition and atomic step to the actual implementation, including concurrency boundaries and the exact correspondence revision. Explain abstractions and why they preserve the property being checked. Provide reproducible tool/version, model, invocation and expected result within the authorized project scope; do not install tooling without permission.

Check the intended model and deliberately introduce a relevant broken variant. Show that the checker detects it and retain the counterexample or other evidence. If the broken variant is not detected, revise the model or report the gap. A passing bounded model is evidence only under its stated assumptions, not proof of all production code.

When code or assumptions change, recheck the mapping and revision before interpreting results. Distinguish model drift, a tooling failure and a real implementation bug; validate any claimed bug against the implementation. Report the property, correspondence, bounds, commands, results and remaining uncertainty. Modeling or reviewing alone does not authorize product repair or pushing.

Adapted from ideas in [pstack formal verification](https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/create-formal-verification-skill), Lauren Tan, 2026.
