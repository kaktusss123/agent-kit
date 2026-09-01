# PR/MR description standard

Keep the description compact and useful to a reviewer. Describe the change at the level of behavior and architecture, not as a narrated diff.

## Default structure

```markdown
## Summary

<Why this change exists and what changes for the user/system. Usually 1-3 short paragraphs.>

## Changes

- <material change>
- <material change>

## Verification

- [x] Automated tests pass: <total count if reliably known>
- [x] Tests added: <count if reliably known>
- [x] Changed-code coverage: <percentage, if available>
- [x] Overall coverage: <before> -> <after> (+<delta> pp), if available

## Review notes

<Only when there is something specific a reviewer should pay attention to.>
```

`Review notes` is optional. Omit it when there is nothing special to review.

Do not include a default `Known issues` section. A defect introduced by the change should normally block publication. Unrelated environment problems usually belong in the work log, not the PR/MR description. Add a separate note only when the information materially helps reviewers understand or reproduce the change.

## Summary

Prefer:

- the reason for the change;
- the externally visible result;
- one important constraint when it changes how the implementation should be understood.

Avoid repeating the task title or listing implementation details that belong under `Changes`.

## Changes

Group related implementation changes. Prefer a few meaningful bullets over a file-by-file list.

Good topics include:

- generator/toolchain changes;
- public contract or schema changes;
- dependency changes that matter to the implementation;
- packaging or generated-artifact changes;
- automation/hooks added as part of the change.

Do not pad the section to reach a fixed number of bullets.

## Verification

Verification is positive-only. The PR/MR should not contain a failure report.

Include only facts supported by evidence already available from the project workflow. Omit unavailable metrics rather than writing `N/A`, `not run`, or `unknown`.

Preferred checklist items:

```markdown
## Verification

- [x] Automated tests pass: 93 total
- [x] Tests added: 14
- [x] Changed-code coverage: 91%
- [x] Overall coverage: 74.2% -> 75.0% (+0.8 pp)
```

If only the pass/fail result is reliably known:

```markdown
## Verification

- [x] Automated tests pass
```

If test counts are known but coverage is not:

```markdown
## Verification

- [x] Automated tests pass: 93 total
- [x] Tests added: 14
```

Use percentage points for the delta between two coverage percentages. For example, `74.2% -> 75.0%` is `+0.8 pp`, not `+0.8%`.

Never infer `Tests added` from a fragile heuristic unless the repository already exposes a trustworthy way to measure it.

## Review notes

Use this section for concrete reviewer attention, such as:

- a documentation URL that needs domain-owner confirmation;
- a deliberate compatibility choice;
- an existing contract quirk intentionally preserved by this change.

Do not turn it into a second `Changes` section.

## Language and style

Follow the repository/team language when it is clear from nearby PRs/MRs or explicit instructions. Otherwise follow the user's language.

Prefer plain technical language. Keep exact command names, file names, versions, identifiers, paths, and measured numbers when they help review.
