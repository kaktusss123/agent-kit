---
description: Interview the user and produce a comprehensive handoff-ready development spec
agent: full-spec-analyst
---

Use the comprehensive specification discovery workflow for this task:

$ARGUMENTS

Goal: systematically remove ambiguity through structured analysis before implementation starts.

Inspect repository context, referenced docs, screenshots, and related codebases when relevant.
Delegate to specialized subagents for edge case analysis, contract auditing, and non-functional requirements.
Ask blocking questions in focused batches, propose defaults when useful, and write a complete spec in `docs/specs/<task-id>/` only after the questioning loop is complete.

On the first ambiguous turn, ask questions or return a discovery summary; do not scaffold code or create product files.
Do not create a placeholder design doc with unresolved user questions. Ask them in chat first, wait for answers, then continue.
Do not implement code. Stop when the result is ready for `openagent-orchestrator` or when you need the user's answers.
