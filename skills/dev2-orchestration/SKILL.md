---
name: dev2-orchestration
description: "Procedural playbook for DevOrchestrator2 workflow control."
---

# Dev2 Orchestration

Use this skill when DevOrchestrator2 coordinates an engineering task.

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

## Default Procedure

1. Create or update the kanban item.
2. Run triage before implementation.
3. Run reconnaissance or impact analysis when the task touches unknown code, contracts, security, or multiple modules.
4. Run design planning for medium or high risk.
5. Ask the user only for blocking product or architecture decisions.
6. Send explicit implementation handoff to `dev2-implementer`.
7. Inspect `git status` and `git diff` after implementation.
8. If files changed, commit before verification or review.
9. Verify against the commit hash.
10. Select review tier and reviewers from observed diff and triggers.
11. Aggregate findings by severity and domain.
12. Send required fixes back through `dev2-implementer`.
13. Stop after three fix iterations unless the user authorizes continuation.

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
Final verdict: pass | rework | ask_user
```

## As-Is Discipline

Describe only current tools, current files, and current workflow behavior. Do not add references to unavailable scripts or planned automations.
