---
name: modernize
description: "Use when assessing or updating an existing PR/MR or stale branch against its current intended base, including requests to modernize or rebase it. Assessment alone is read-only; updating, pushing, closing and merging need their own authority."
---

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove that the change is still needed. An assessment request is read-only: do not modify a checkout, rebase, push, close or merge. An explicit request to update or rebase authorizes only the corresponding in-scope mutation, not publication or merge unless separately authorized. Do not infer full-send from modernization.

## Restore intent and assess

Resolve the PR/MR and its actual source repository, branch and head, target repository and intended base; inspect its state, author, title, description, linked issues, commits, complete diff, checks and review threads. Establish the smallest original product goal and the merge base. Obtain current remote head and base evidence; for read-only assessment inspect the forge or remote without mutating a checkout. Do not assume the default branch is the target.

Inspect changes on the intended base since divergence and relevant merged or open replacements. Check whether the problem is already solved, interfaces and ownership changed, code was moved or removed, or the old patch would restore obsolete behavior or duplicate a current solution. Separate observed facts from judgment. Age and sunk effort alone are not evidence.

Before any rebase choose and explain one disposition:

- `MODERNIZE`: the goal and implementation shape remain useful; update against the actual base.
- `REWORK`: the goal remains useful but a mechanical rebase would preserve the wrong implementation. Describe the smallest credible change. Proceed only when the rework is an ordinary implementation choice within the delegated scope; a materially different product goal requires a decision.
- `CLOSE`: concrete evidence shows the change is obsolete, superseded or not worth its cost. This is a recommendation, not permission to close.

## Authorized update

Use `skill://git-task` for a managed worktree and owner; never create a raw temporary writing worktree or edit another owner's checkout. Record the pre-rebase remote head and preserve intended behavior and author/co-author metadata. Rebase or rework against the current intended base, resolve conflicts against current invariants, inspect `git range-diff` and the final diff, and check that neither intent nor already-landed behavior was lost or duplicated. Stop on a material product disagreement rather than guessing.

Commit the candidate through `skill://git-commit`, then verify the final candidate using `skill://verification-design`. An update does not silently authorize pushing: if push is separately granted, use a lease tied to the recorded remote head on the assigned branch only, and never overwrite another live writer. On lease failure reassess, not unconditional force. Follow `skill://change-request` for separately authorized publication; do not post comments or merge without authority.

Report the disposition and evidence, meaningful base changes and conceptual conflicts, mutation and push results if any, checks and limitations, and the remaining decision. Do not claim a clean rebase proves product relevance.

Adapted from [tstack modernize](https://github.com/t3dotgg/tstack/tree/11e37a74d0a6868c121cd0910ab2b3bd9873b92a/skills/modernize), Copyright (c) 2026 Theo Browne, MIT; see [LICENSE](LICENSE).
