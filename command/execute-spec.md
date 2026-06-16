---
description: Execute an approved specification through the dev-orchestrator engineering workflow
agent: dev-orchestrator
---

<!-- markdownlint-disable MD041 -->

Execute the approved specification referenced by the user:

$ARGUMENTS

The spec reference must be explicit — a path to a spec workspace folder, a path to a `spec.md` file, or a task-id/workspace identifier. If `$ARGUMENTS` is empty or contains no accepted spec reference, do not guess from recency or chat state; return a short usage hint listing the accepted reference forms and stop.

Inspect the referenced paths early using read/glob/grep tools; surface any external path that needs approval before continuing.

Begin with a spec-validation phase: read every artifact in the referenced spec workspace, cross-check the spec's claims against the current repository state, and look for contradictions, missing decisions, or untestable acceptance criteria. If material gaps remain, stop and list them to the user — do not skip to implementation on an incomplete or contradictory spec.

After validation passes, continue through the normal engineering workflow and stop when the latest implementation commit has no remaining defects awaiting user approval.
