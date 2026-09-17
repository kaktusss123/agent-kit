---
name: verification-design
description: "Design the smallest trustworthy verification plan for a software change. Use during planning, implementation planning, review, or task cracking when the agent must choose commands, tests, scripts, or manual checks that can actually observe the requested behavior and important failure modes without relying on proxies."
---

# Verification design

A verification check earns its place only if it can falsify a meaningful claim.

## Discover existing checks first

Inspect project scripts, Makefiles, CI, test layout, contribution docs, and nearby precedent. Prefer canonical project checks over invented commands.

## Map claims to evidence

For each material acceptance claim, ask:

- What observable would prove or disprove it?
- What is the highest practical seam that sees that observable?
- What existing focused command reaches that seam?
- Which failures need a dedicated regression test or reproduction script?

Prefer a focused deterministic check when it proves the claim. Add broad suites when project policy requires them or the change has a wide enough impact that focused checks cannot cover it.

## Avoid false confidence

Do not use:
- compile success as proof of runtime behavior;
- a unit test that bypasses the integration being changed;
- snapshots that cannot fail on the requested behavior;
- manual inspection when a cheap deterministic check exists.

A negative or blocking conclusion needs a positive control through the same probe path when feasible. Prove that the probe can observe a known-success case before trusting its failure result.

Treat a command or tool failure, malformed response, or unclassified timeout as probe failure, not product success. A timeout counts as product evidence only when it is the explicitly expected observable, the probe is bounded, and a same-path positive control succeeds. If the harness cannot observe the claim, record the check as `NOT_RUN` or blocked and state why.

Verify the complete user-visible contract relevant to the claim, not one convenient field. For tabular results, this means status, columns or schema, and rows.

If deterministic verification is unavailable, say exactly what remains manual and why.

## Output

Produce a compact, evidence-oriented verification contract:
- check name;
- where it runs;
- exact command or procedure;
- requirement it observes;
- required vs advisory/manual status.
