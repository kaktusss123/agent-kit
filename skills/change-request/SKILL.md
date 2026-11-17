---
name: change-request
description: "Draft, inspect, create, or explicitly update GitHub pull requests and GitLab merge requests with a consistent description format. Use when: the user asks to prepare or standardize a PR/MR description; publish completed changes as a PR/MR; inspect or update an existing change request. Not for: reviewing someone else's MR/PR from a link; use skill://lazy-mr-review."
---

# Change request

Use a lightweight workflow. Prefer the installed forge CLI over custom API wrappers. Do not introduce provider abstractions, error normalization, or deterministic code until real usage proves they are needed.

## Core rules

- Separate description drafting from publication. A user may ask for either one. An explicitly assigned `skill://full-send` mode (full send or full stop) grants creation/update of the task's PR/MR and scoped technical replies/resolve operations after verifying the finding and successful publication; do not ask for that permission again. Discussion, quotes and limited delegates' background context do not grant publication.
- Keep git mutation outside this skill. Do not commit, push, rebase, merge, or create/delete branches here.
- Never silently choose GitHub vs GitLab, a host, or a repository among several candidates. Ask the user when the target is genuinely ambiguous; a single resolving remote needs no question. Read-only remote inspection may be used to offer likely choices.
- Support arbitrary GitHub and GitLab hosts. Never encode organization-specific hostnames as architecture.
- Use `gh` for GitHub and `glab` for GitLab. Load only the matching provider reference.
- Every GitLab MR creation MUST pass `--squash-before-merge=true` to `glab mr create`; do not rely on a GitLab UI or project default to enable squash.
- Preserve CLI failures. Report the command context, exit status, stdout, and stderr as produced. Do not map message text to a private error taxonomy.
- Treat create and update as different operations. `create` must never silently become `update`.
- Before changing an existing PR/MR, read its current title and description. Preserve fields and manual content the user did not ask to replace.
- Do not fabricate test counts, coverage, commands, links, ticket IDs, or implementation claims.
- When several related PRs/MRs are drafted together, normalize them as a set rather than preserving accidental stylistic differences between drafts.

## Workflow

1. Determine the requested operation: `draft`, `inspect`, `create`, or `update`.
2. Gather facts from the current conversation and available repository evidence. Read-only git commands are allowed when they help understand the change or identify candidate remotes.
3. Load [references/description.md](references/description.md) and prepare the title/body. If several sibling PRs/MRs are in scope, compare and normalize them together before finalizing any one draft.
4. If the request is only `draft`, return the draft and stop.
5. Resolve the publication target. Require provider, host, repository, source branch, and target branch to be known. When several repositories or hosts are candidates, ask the user instead of guessing; candidate remotes may be shown as suggestions. When the user already requested publication for this repository and a single remote with its default branch resolves the target unambiguously, proceed without re-asking. Never push, fork, or select silently among several candidates.
6. Load [references/github.md](references/github.md) for GitHub or [references/gitlab.md](references/gitlab.md) for GitLab.
7. Run the minimal provider preflight: verify the CLI exists and verify authentication for the selected host. Use the installed CLI's `--help` when exact flags differ by version.
8. For `create`, verify that the source branch already exists remotely. If it does not, stop and hand off to the git workflow. Do not push or let an interactive CLI flow push/fork on this skill's behalf.
9. For `create`, check for an existing open PR/MR from the same source branch to the same target repository/branch. If one exists, report it and stop; never silently convert `create` into `update`. Under an explicit autonomous grant allowing both, resolve the operation as `update` at step 1 when that exact PR/MR already exists, rather than asking again.
10. For `update`, inspect the existing PR/MR first. Change only the fields requested by the user. If replacing the description would discard unrelated manual content and the user's intent is not explicit, show the conflict and ask before overwriting.
11. Execute the requested provider operation non-interactively where practical, supplying explicit repository, branches, title, and description, per the provider reference's mandatory flags.
12. Return the resulting PR/MR URL. If the CLI fails, return the original failure output and do not invent a diagnosis that the CLI did not establish.

## Publication readiness

Separate pre-publication gates from PR-dependent readiness and merge checks; publication is not completed acceptance.

- Before publication, obtain all available local verification evidence, the candidate commit and hook results through the git workflow. Required local checks must pass. Required checks that do not depend on PR/MR publication must pass before creation, including branch CI available after push. Known required-check failures, deferred-hook gaps and explicit hard project publication restrictions block creation; a pending remote check cannot waive them. A deferred check must be re-run and pass before creation.
- Establish the actual required checks and their triggers from workflow configuration or authoritative forge evidence, including branch filters and draft behavior. Unknown policy or an empty/transient checks response does not prove PR-only CI or the absence of CI. Unexplained missing checks still block publication.
- If pre-publication gates pass and evidence proves the remaining required CI can run only after PR/MR publication, existing scoped publication authority permits provisional create/update to obtain that evidence. Do not ask again for already delegated creation. Prefer draft only when that workflow runs on drafts; otherwise use an authorized ordinary PR/MR with honest pending status. A draft that skips the required CI is not a solution. This exception does not grant publication authority or override a project's hard pre-publication rule.
- In a provisional PR/MR, list proven passes in `Verification` and identify the pending PR-dependent checks and their trigger evidence in `Review notes`. Never present failed, skipped, unknown, not-run or pending checks as passed, or label the change `READY` before acceptance.
- All required checks and any required independent review must pass for the exact current candidate and target base before `READY` or merge; apply the project's review policy and the `skill://git-task` review decision point outside autonomous modes. Full send/full stop retain their mandatory independent review. Re-check after head or base changes. Failed, missing, unknown or pending required checks remain readiness blockers after publication. This skill never merges or enters a queue. Auto-merge requires readiness and merge authority. Only full send (not full stop), under `skill://full-send`, permits controlled required-queue admission before proven queue-only CI, after all pre-queue checks and independent review pass. Queue admission is not final readiness: final queue checks must pass before merge. This is not permission for arbitrary auto-merge before unverified CI. Full stop never merges, enables auto-merge or enters a queue; if a required check needs queue entry, report that remaining gate as blocked, not `READY`. Inspect and preserve its no-merge state through `skill://full-send` before publication.
- Distinguish an established absence of configured hosted CI (report that fact) from unknown policy or an empty/transient response. Never claim a green pipeline where none ran.
- Material limitations of optional or advisory checks (unavailable tooling, environment limits) may be noted briefly in `Review notes` per [references/description.md](references/description.md); they never substitute for a required check. Do not invent a universal test command or require metrics the project does not provide.
- A description may still be drafted before publication readiness is established. Review readiness, publication authority and merge authority are separate.

## References

- [references/description.md](references/description.md): canonical description structure and verification checklist.
- [references/github.md](references/github.md): GitHub workflow with `gh`.
- [references/gitlab.md](references/gitlab.md): GitLab workflow with `glab`.
