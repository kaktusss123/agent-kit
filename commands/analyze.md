---
description: Free-form project analysis, Q&A, code smell detection, and pre-discovery research
agent: project-analyst
---

<!-- markdownlint-disable MD041 -->

Run the free-form project analysis workflow for this request:

$ARGUMENTS

Goal: answer questions, diagnose issues, explore architecture, or perform pre-discovery research without producing specs or making changes.

Inspect the repository or any referenced docs only as much as needed. Probe referenced paths early using read/glob tools only — do not assume shell access. If a referenced path cannot be resolved, surface it explicitly and continue with what is available. If a referenced external path is detected and needs approval, surface that to the user and wait for explicit approval before continuing.

If the request is empty or too vague to act on, return a short usage hint and stop.

Load the skill that matches the analysis intent, delegate to a subagent when a matching specialist exists, and report findings conversationally. Cite file paths and line numbers for factual claims. Distinguish evidence, inference, and missing information.

If at any point the request turns out to require a specification, implementation, or testing campaign, explicitly recommend `/spec`, `/spec-lite`, `/execute-spec`, or `/test` and stop. Do not write files or run commands.
