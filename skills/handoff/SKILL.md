---
name: handoff
description: "Compact an active engineering conversation or investigation so another agent or future session can continue without replaying the transcript. Use in ordinary chat, plan mode, long investigations, session changes, or before context reset when durable state, decisions, evidence, open questions, and next actions must survive."
---

# Handoff

Write for a capable agent entering cold.

Preserve the minimum state needed to continue correctly:
- objective and current scope;
- important established facts with evidence pointers;
- decisions already made and why;
- constraints and non-goals;
- work completed and current artifact/repo state;
- verification already run and exact results;
- the exact verified invocation and required environment when continuation depends on them, preferably in a durable script or config instead of prose;
- the authoritative source and safe retrieval or derivation procedure for required secret or environment-bound values, without recording secret values or leaving placeholders that a cold agent cannot resolve;
- unresolved questions or blockers;
- next concrete actions.

Separate facts from hypotheses. Record known traps only when they prevent repeated failure. Do not preserve other dead exploratory branches.

Do not claim tool results from memory when the transcript does not support them.

Prefer references to durable artifacts over copying large payloads. The handoff should be much smaller than the conversation it replaces.
