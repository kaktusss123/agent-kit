---
description: Orchestrate test planning, implementation, and verification for Python projects
agent: tester
---

<!-- markdownlint-disable MD041 -->

Run the test orchestration workflow for this request:

$ARGUMENTS

Accept free-text hints: a mode hint (`diff-oriented`, `targeted`, `bootstrap-coverage`), a target hint (file, module, package, or pytest filter), or a plain description of the test goal.

If the input is empty, too vague to classify, or mode inference fails, default to `diff-oriented` mode against current changes. State the selected or inferred mode explicitly in the first response before any other content.

Inspect any referenced paths early using read/glob/grep tools only — do not assume unrestricted shell access. If a referenced path cannot be resolved, surface it explicitly and continue with what is available.

Do not skip baseline or coverage collection. Do not add tests on top of an unexplained red baseline. Continue through planning, writing, review, and final verification, and stop when the final report is written.
