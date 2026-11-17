---
name: council
description: "Use when the user requests a council of selected models to independently assess an artifact or code change against a shared threshold and converge within a bounded review budget. Not for a single ordinary review; use skill://code-review."
---

# Council

Orchestrate independent assessments, not a separate review engine. For code, use `skill://code-review` and its verdict and evidence contract; a council round is one assessment per participant, not a nested full review-loop per participant. Repairs follow `skill://git-task` through a fresh managed owner. Do not write to a checkout while any participant reviews it.

## Intake

Fix the intended artifact and task, assessment criteria, user-selected model seats, a desired threshold on a 1–10 scale, and a finite round budget (default three, initial round included). These may come from explicit current-task instructions or explicit user/project settings. Resolve model identifiers using the actual host registry and report identities and effort as actually exposed. Do not invent providers, seats, model identity, usage or a threshold. If models or threshold are missing, ask for them; if an exact requested model cannot run or the host cannot resolve it, report the specific blocker. Never silently substitute a model. Validate that the threshold and every returned score are finite numbers within 1–10, and that the round budget is a positive finite integer (or an explicit finite time limit). Out-of-range or malformed values are blockers, not scores to clamp or infer. Seats are mandatory unless the user explicitly marks them optional; do not reclassify a failing seat.

## Each round

Give every selected mandatory participant the same fixed snapshot, intent, criteria and rubric independently, without other reviewers' answers. For code, specify exact base and head and require read-only review of the full candidate and relevant base interaction. The controller may inspect returned evidence while others run but must not mutate the reviewed checkout until all readers are finished. Optional seats may provide feedback but cannot replace mandatory seats.

Request findings with concrete evidence and dispositions, the applicable review verdict, and a 1–10 score with reasons for deductions. A score is a subjective readiness judgment, not a probability of correctness. Use the same rubric across rounds: 1–3 means fundamental gaps or insufficient evidence, 4–6 substantial concerns, 7–8 mostly ready with remaining limitations, 9–10 strong evidence and no material unresolved concerns. Findings and verdict remain authoritative: report inconsistent results, such as `FAIL` with 10/10, as invalid rather than accepting them.

Evaluate findings against the fixed intent and evidence; maintain stable IDs and `fixed`, `disputed`, or `declined` dispositions. Refute false positives with evidence, do not implement ordinary style suggestions merely to buy a score, and do not expand scope. Unresolved material disagreement is a blocker. After justified fixes, commit and verify the new candidate and ask every mandatory participant for a fresh assessment of the actual candidate and relevant base; only that participant's reassessment can change its score. A score from an earlier head or base is stale. A delta-only review cannot establish full current-candidate acceptance without relevant base interaction.

## Convergence and report

Convergence requires **every** mandatory participant to provide a valid current-snapshot assessment at or above the threshold: use the minimum score, never an average. Also require no unresolved verified blocking findings, human change requests, or failed, missing, pending or unknown required checks. A blocker overrides a high score. For code, any `FAIL` verdict prevents convergence even at or above the threshold; static-only or delta-only verdicts cannot stand in for required executed checks or full base interaction. Distinguish confirmed absence of configured hosted CI from unknown policy or a transient empty result; do not claim a green pipeline when none ran. Missing score, response or model, timeout, invalid verdict/score combination, stale result or failed run is not success. Never drop a strict reviewer or lower the threshold to converge.

Stop on convergence, an unresolvable blocker, or budget exhaustion. At the configured budget (default three rounds) without convergence report `NOT CONVERGED` or `BLOCKED`, not `PASS`. Return the actual model identities and effort where exposed, per-round snapshot and scores, finding dispositions, check status, gaps, unresolved reasons and the next decision. Do not invent usage. Publish a council summary in the PR/MR description only when publication is authorized; preserve unrelated manual content and omit private paths and transcripts (`skill://change-request`).

Adapted from [tstack council](https://github.com/t3dotgg/tstack/tree/11e37a74d0a6868c121cd0910ab2b3bd9873b92a/skills/council), Copyright (c) 2026 Theo Browne, MIT; see [LICENSE](LICENSE).
