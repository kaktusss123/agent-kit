---
name: code-review
description: "Review a proposed or implemented change against two independent questions: does it satisfy the intended spec/request, and is the engineering sound for the repository. Use for branch, diff, PR, or work-in-progress review. Keep contract fidelity separate from engineering quality so one cannot hide failure in the other."
---

# Code review

Review the actual diff against a fixed base when possible.

## Axis 1: intent and spec

Check:
- required behavior missing or partial;
- behavior that contradicts confirmed decisions;
- unjustified scope expansion;
- acceptance/failure scenarios not implemented;
- silent semantic changes outside the request.

Cite the requirement or decision for each finding.

## Axis 2: engineering

Check the changed code and necessary surrounding context for:
- correctness and failure paths;
- ownership and dependency direction;
- unnecessary complexity or abstractions;
- compatibility/migration concerns;
- state/retry/recovery issues;
- test quality and verification gaps;
- repository-specific documented standards.

Use specialized skills such as `skill://blast-radius` for non-obvious downstream risk when warranted.

## Findings

Separate blocking correctness/contract issues from maintainability suggestions. Give a concrete mechanism and evidence. Do not manufacture findings to make a review look thorough.

Do not auto-apply fixes unless asked. Do not require multiple reviewers or models. The environment may add independent reviewers later without changing this review contract.
