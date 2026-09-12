---
name: review-orchestration
description: "Organize independent review without over-spawning reviewers. Use when a primary agent needs to delegate review of code or specification artifacts: choose the matching review skill, discover its current lenses, group related lenses into one reviewer by default, split only when separate context or model adds real value, run independent jobs in parallel, and aggregate evidence-backed findings."
---

# Review orchestration

Organize review; do not perform the detailed review in the caller's context.

## Plan the review

1. Identify the exact target and governing context: request, spec, acceptance criteria, or other source of intent.
2. Choose the review skill for the target. Use `code-review` for code checkpoints and `spec-review` for specifications. Load that skill before delegation to discover its current lens registry and triggers. Do not maintain a lens catalog here.
3. Select the applicable lenses from that review skill.
4. Default to one fresh `reviewer` with all related lenses.
5. Split into additional reviewers only when another independent context adds real value: clearly disjoint scopes, a target too broad for one useful pass, a deliberate independent second opinion, or a different model such as `security-reviewer`. More lenses alone are not a reason to spawn more agents.
6. Run independent reviewer jobs in parallel when possible.

## Delegate

Give each reviewer:

- the exact target;
- the governing context needed to judge it;
- the review skill to load;
- one or more assigned lenses.

Do not copy detailed lens instructions into the delegation prompt. The reviewer loads the same review skill in its fresh context and follows the assigned lenses there.

For materially security-sensitive work, use the model-bound `security-reviewer` for the security pass rather than pretending that another generic reviewer gives model diversity.

## Aggregate

Combine findings by evidence, not votes. Deduplicate equivalent findings. One substantiated blocking defect remains blocking even if other reviewers passed.

If reviewers disagree, inspect the evidence or run a focused follow-up rather than taking a majority vote.

After a repair, rerun only the review scopes that the new change could invalidate. Rerun broader review when the repair itself is broad or changes the original assumptions.
