---
name: orchestration
description: "Procedural playbook for DevOrchestrator workflow control."
---

# Orchestration

Use this skill when DevOrchestrator coordinates an engineering task.

## Stage Model

Track one current stage at a time:

1. `triage`
2. `impact`
3. `design`
4. `plan_check`
5. `implement`
6. `commit`
7. `verify`
8. `review`
9. `fix_loop`
10. `await_user_approval`
11. `done`

Record each stage transition in kanban.

## Handoff Template

Every delegated prompt must include:

```text
Stage: <stage>
Mode: <plan_check | commit_verify | n/a>
# Use n/a only when the receiving agent has no mode-specific workflow.
Objective: <one paragraph>
Scope:
- allowed files/modules
- must-not-touch paths
Inputs:
- request
- decisions
- acceptance criteria
- previous artifacts or commit hash
Expected output:
- exact sections required
Stop conditions:
- blockers
- needs_more_context triggers
```

`commit_verify` corresponds to the `verify` stage after a commit hash exists.

## Default Procedure

1. Create or update the kanban item.
2. Run triage before implementation.
3. Run reconnaissance or impact analysis when the task touches unknown code, contracts, security, or multiple modules.
4. Run design planning for medium or high risk.
5. Ask the user only for blocking product or architecture decisions.
6. Send explicit implementation handoff to `implementer` using the handoff template above.
7. Inspect `git status` and `git diff` after implementation.
8. If files changed, commit before verification or review.
9. Verify against the commit hash with `Mode: commit_verify` in the handoff.
10. Select review tier and reviewers from observed diff and triggers.
11. Send review handoffs using the handoff template above.
12. Aggregate findings by severity and domain.
13. Send required fixes back through `implementer` using the handoff template above.
14. Stop after three fix iterations unless the user authorizes continuation.

## Skill Topology

| Agent | Required Skill(s) |
|---|---|
| `dev-orchestrator` | `orchestration` |
| `implementer` | `implementation`, `testing-python` for Python tests |
| `verification-engineer` | `verification`, `verification-gate` |
| `reviewer-*` | `review` |
| `reviewer-tests` | `review`, `testing-python` |
| `reviewer-complexity` | `review`, `complexity-review` |

## Review Tier Checklist

Calculate and state:

- effective file count;
- logical changed lines;
- security triggers;
- contract/API triggers;
- test changes or missing regression coverage;
- performance/complexity triggers;
- selected tier and reviewers.

## Fix Loop Accounting

For each iteration, write to kanban:

```text
Fix iteration: <1-3>
Source findings:
- reviewer/verifier + finding id
Fix scope:
- files
Commit:
- hash
Result:
- pass/fail/residual risk
```

Stop or escalate when:

- the same finding appears again;
- finding count does not decrease;
- the fix requires a new design decision;
- verification cannot run for environmental reasons.

## Aggregation Template

```text
## REVIEW AGGREGATION
Scope commit: <hash>
Tier: <R0-R4>
Consensus defects:
- severity + source reviewers + evidence
Plan deviations:
- item + evidence
Security findings:
- item + evidence
Domain warnings:
- item + evidence
Required fixes:
- item + owner
Residual risks:
- item + rationale
Final verdict: PASS | PASS_WITH_NOTES | FAIL | BLOCKED | ASK_USER
```

## As-Is Discipline

Reference only files, commands, tools, and skills that exist in the current repository or are explicitly allowed in the active agent permission block.
