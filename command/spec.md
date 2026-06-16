---
description: Comprehensive specification discovery for complex features — interview, analyze, and produce an implementation-ready spec
agent: full-spec-analyst
---

<!-- markdownlint-disable MD041 -->

Run the comprehensive specification discovery workflow for this task:

$ARGUMENTS

Goal: systematically remove ambiguity through structured analysis before implementation starts.

Inspect repository context, referenced docs, and any paths the user provided. Probe each referenced path early using read/glob/grep tools; if a path sits outside the workspace, surface it to the user for approval before continuing.

If the request is empty or too vague to act on, return a short usage hint and stop.

Ask blocking questions in focused rounds, propose defaults when useful, and write the final handoff-ready spec only after the questioning loop is complete. Before producing the spec, summarize your understanding of the task in Russian and wait for explicit user approval. Do not write a placeholder design doc with unresolved questions.

Do not implement code. Stop when the spec is ready to be handed off (via `/execute-spec`) or when more user answers are required.
