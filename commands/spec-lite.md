---
description: Lightweight specification for straightforward features — quick clarification and handoff-ready spec
agent: FastSpecAnalyst
---

<!-- markdownlint-disable MD041 -->

Run the lightweight specification workflow for this straightforward change:

$ARGUMENTS

Goal: remove ambiguity quickly and produce a small handoff-ready spec without the full discovery overhead.

Inspect the repository or any referenced docs only as much as needed. Probe referenced paths early using read/glob tools only — do not assume shell access. If a referenced path cannot be resolved, surface it explicitly and continue with what is available. If a referenced external path is detected and needs approval, surface that to the user and wait for explicit approval before continuing.

If the request is empty or too vague to act on, return a short usage hint and stop.

Ask focused follow-up questions in small batches, separate facts from assumptions, and write the spec only after the interview is sufficiently complete. Use the mandatory first-response structure with `## What I Understand / Что я понял`, `## What's Ambiguous / Что неоднозначно`, and `## Blocking Questions / Блокирующие вопросы` before writing any spec file.

If at any point the request turns out to be too broad, ambiguous, high-risk, or involves external integrations, explicitly recommend escalating to `/spec` and stop. Do not implement code.
