---
name: dev2-review
description: "Shared read-only review protocol for Dev2 domain reviewers."
---

# Dev2 Review

Use this skill when a Dev2 reviewer examines a committed change.

## Reviewer Contract

- Review only the provided commit scope.
- Do not edit files, patch files, write files, or update kanban.
- Do not delegate to another agent.
- Prefer cited evidence over general advice.
- Separate defects from preferences and residual risks.

## Required Inputs

Stop with `needs_more_context` when any required input is missing:

1. Review domain.
2. Review tier.
3. Scope commit.
4. Base ref.
5. Original request or acceptance criteria.
6. Changed files or diff access.
7. Verification summary or explanation that verification is unavailable.
8. Known deviations and constraints.

## Review Steps

### 1. Confirm Scope

Identify exactly what the commit changes:

- files changed;
- behavioral surface affected;
- contracts, permissions, data, or security boundaries touched.

Ignore unrelated untracked files unless the prompt includes them.

### 2. Apply Domain Lens

Apply the domain lens specified by your agent identity. Use `dev2-review` for shared mechanics only: scope control, evidence, severity, and verdict shape.

Reviewers load `dev2-review` plus any existing domain-specific skill named in their agent file.

### 3. Grade Findings

Use this severity rubric:

| Severity | Meaning |
|---|---|
| Critical | Unsafe to use; data loss, credential exposure, remote compromise, or broken workflow invariant |
| High | Likely production defect, security boundary failure, or major regression |
| Medium | Real defect or maintainability risk that needs a planned fix |
| Low | Minor issue, unclear wording, narrow edge case, or local cleanup |
| Info | Observation without required code change |

### 4. Decide the Verdict

- **PASS**: no required fixes.
- **PASS_WITH_NOTES**: only low/info findings or accepted residual risks.
- **FAIL**: any critical/high finding, or medium finding that blocks the stated acceptance criteria.
- **BLOCKED**: required inputs are missing.

## Output

Return this structure:

```text
## REVIEW COMPLETE
Domain: <domain>
Tier: <R0-R4>
Scope commit: <hash>
Verdict: PASS | PASS_WITH_NOTES | FAIL | BLOCKED
Findings:
| id | severity | location | finding | evidence | remediation |
|---|---|---|---|---|---|
| R1 | <severity> | file:line | issue | quote or command result | required action |

Severity is one of: Critical, High, Medium, Low, Info.
Plan deviations:
- none | item
Residual risks:
- risk + why it remains
```

## Anti-Patterns

| Avoid | Why | Use Instead |
|---|---|---|
| Reviewing the whole repository | Breaks commit-scoped review | Review base ref to scope commit |
| Reporting style preferences as defects | Creates noise | Map findings to risk or criteria |
| Guessing line evidence | Weakens review | Cite exact files and lines |
| Suggesting unavailable tools | Violates as-is discipline | Recommend current repo actions only |
