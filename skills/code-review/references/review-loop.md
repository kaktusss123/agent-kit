# Bounded review-loop

Use this optional mode when iterative independent review is requested. It does not grant implementation, publication, or merge authority. Each reviewer applies `skill://code-review` and is read-only; a council seat performs one assessment per council round, never its own nested loop.

## Contract and budget

Fix the intended behavior, scope, acceptance criteria, required checks, exact base and candidate head before each review. Keep intent and scope fixed across rounds. Record each snapshot and its applicable check results. If the base or head moves, the prior assessment is stale: establish the new snapshot, re-check base interaction and required checks, and review the current candidate before acceptance. Missing, failed, unknown, or stale required checks and valid open blockers cannot pass. Distinguish confirmed absence of configured hosted CI from unknown policy or an empty transient result; never claim a pipeline ran when it did not.

Default to at most three review rounds, including the initial pass. The user may set a different finite round budget or time limit. Stop on acceptance, an unresolved material disagreement, a capability blocker, or exhaustion. A timeout, failed run, missing response, or exhausted budget is not approval.

Use the host's configured native reviewer role for a standalone loop unless the user names a model. If a model is named, run that exact model; unavailable binding, model, or host capability is a blocker, not permission to substitute another model. Do not invent model identity or provider details.

## Review, disposition, repair

1. Review the fixed snapshot independently against intent and engineering, using the existing output and severity contract. Give findings stable IDs across rounds, severity, concrete mechanism and evidence. A rare but reachable contract, security, or data-loss defect is not a nit merely because it is rare.
2. Evaluate material findings against the fixed intent and evidence. Record each as `fixed`, `disputed`, or `declined`, with rationale and evidence; a claimed fix needs verification on the changed candidate. Do not expand scope to appease a reviewer. An unresolved material disagreement is a blocker: show both positions and evidence rather than silently lowering criteria.
3. Route justified repairs through `skill://git-task`: a fresh owner inspects the settled state, repairs within scope, commits and verifies the candidate. Reviewers never repair their own findings or write to the reviewed checkout. If the host cannot provide the required owner or independent review, stop and report the limitation.
4. Subsequent rounds focus on changed code and open findings, while checking relevant interaction with the base. A delta-only review cannot become plain `PASS` or current-candidate acceptance without that interaction. Preserve `PASS`, `FAIL`, `PASS (static only)`, and `PASS (delta only, base interaction unverified)` and the existing P0–P2 meanings. Static-only evidence does not satisfy a required executed check.

Report the verdict, round budget and rounds used, base/head per round, checks and gaps, findings with dispositions and evidence, and the concrete blocker or next decision if not accepted. This limited findings record is review output, not a mandatory persistent decision journal.

Adapted from [tstack sol-loop](https://github.com/t3dotgg/tstack/tree/11e37a74d0a6868c121cd0910ab2b3bd9873b92a/skills/sol-loop), Copyright (c) 2026 Theo Browne, MIT; see [LICENSE](../LICENSE).
