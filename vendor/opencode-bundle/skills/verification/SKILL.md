---
name: verification
description: "Procedural playbook for plan checks and commit verification."
---

# Verification

Use this skill when `verification-engineer` validates a plan or a committed change.

## Modes

### `plan_check`

Use `plan_check` before implementation. Verify that the plan is executable and testable.

Required inputs:

1. Original request.
2. Proposed scope.
3. Acceptance criteria.
4. Impact or reconnaissance notes.
5. Planned verification commands or manual checks.

### `commit_verify`

Use `commit_verify` after the committer returns a commit hash.

Required inputs:

1. Commit hash.
2. Base ref.
3. Changed files.
4. Acceptance criteria.
5. Implementation summary.
6. Known deviations and risks.

Reject relative-only references such as “same as above”.

## Verification Matrix

Build a matrix before running checks:

| Acceptance Criterion | Evidence Needed | Check Type | Result |
|---|---|---|---|
| criterion text | file, command, or manual observation | test/lint/type/build/manual | pass/fail/not run |

Check types:

- **test**: unit, integration, regression, or snapshot test.
- **lint**: style, import, dead-code, or static policy check.
- **type**: type checker or compile check.
- **build**: package, bundle, or config parse check.
- **manual**: explicit inspection with cited evidence.

## Command Selection

Run only commands that match the repository and the handoff.

Prefer the narrowest command:

1. Targeted test for changed behavior.
2. Package or module test when targeted command is unavailable.
3. Lint/type/build check when the change affects code shape or config.
4. Manual evidence when no executable check exists.

Do not invent commands. If a command is not known from project files or handoff, mark it as not run and explain why.

## Failure Classification

Classify every failed or missing check:

- **blocking**: acceptance criteria cannot be confirmed, or a regression is observed.
- **non-blocking**: evidence is weaker than preferred, but the implemented behavior is still supported.
- **environmental**: check cannot run because a dependency, service, or local tool is unavailable.
- **out-of-scope**: failure is unrelated to the committed diff; cite evidence.

## Output

Return this structure:

```text
## VERIFICATION COMPLETE
Mode: plan_check | commit_verify
Status: PASS | FAIL | BLOCKED
Scope commit: <hash or n/a>
Checks run:
- command/manual check: result + evidence
Acceptance matrix:
- criterion: pass/fail/not run + evidence
Failures:
- severity + evidence + required fix
Residual risks:
- risk + reason
Recommendation: pass | rework | ask_user
```

## Stop Conditions

Return `blocked` or `needs_more_context` when:

- no commit hash is provided for `commit_verify`;
- acceptance criteria are missing;
- the handoff omits changed files and no diff access is provided;
- required verification depends on credentials or services not available in the environment.
