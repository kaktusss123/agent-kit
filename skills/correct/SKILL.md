---
name: correct
description: "Investigate a rejected assistant output or report and correct the underlying mistake. Use when: the user says a result is wrong or asks why it happened; distinguish a one-off from a recurring failure before proposing durable enforcement. Not for: routine editing of prose."
---

# Correct

Invoke when the user rejects the result, not only while execution is being watched. For example: "This report says the tests passed, but they did not. Correct this and find out why."

1. Identify the rejected claim and the expected outcome. Inspect the report and available evidence from this authorized session: tool results, relevant diff, tests, history and review. Separate observations from inference; if evidence is missing, say what cannot be established rather than asking the user to reconstruct execution already available.
2. Trace the actual mistake and its cause. Check whether the evidence shows a single incident or multiple instances of the same mechanism. Do not infer a pattern from one incident or demand two user-supplied incidents. A focused correction or diagnosis can be enough for a one-off.
3. For a recurring class, propose the narrowest effective protection at an agreed scope. Prefer making invalid states impossible through architecture or types, or adding a targeted check or test, over another instruction when justified. Do not add a lint or rewrite a repository automatically for every complaint.
4. For any durable protection, demonstrate that it catches a real past violation and permits nearby valid cases; report the evidence and limitations. If the historical case or a suitable seam is unavailable, say so instead of claiming protection.

Report the mistaken claim, evidence, cause, correction or proposed guard, and any unresolved uncertainty. A rejected report alone does not authorize unrelated writes, publishing or pushing; follow the active task's write scope.

Adapted from ideas in [pstack correct](https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/correct), Lauren Tan, 2026.
