---
name: change-request
description: Draft, inspect, create, or explicitly update GitHub pull requests and GitLab merge requests with a consistent description format. Use when the user asks to prepare or standardize a PR/MR description, publish completed changes as a PR/MR, inspect an existing change request, or update one. Use gh for GitHub and glab for GitLab after the publication target is resolved. Keep git mutation such as commit, push, rebase, and branch management outside this skill.
---

# Change request

Use a lightweight workflow. Prefer the installed forge CLI over custom API wrappers. Do not introduce provider abstractions, error normalization, or deterministic code until real usage proves they are needed.

## Core rules

- Separate description drafting from publication. A user may ask for either one.
- Keep git mutation outside this skill. Do not commit, push, rebase, merge, or create/delete branches here.
- Never silently choose GitHub vs GitLab, a host, or a repository when the publication target is not explicit. Ask the user. Read-only remote inspection may be used to offer likely choices.
- Support arbitrary GitHub and GitLab hosts. Never encode organization-specific hostnames as architecture.
- Use `gh` for GitHub and `glab` for GitLab. Load only the matching provider reference.
- Preserve CLI failures. Report the command context, exit status, stdout, and stderr as produced. Do not map message text to a private error taxonomy.
- Treat create and update as different operations. `create` must never silently become `update`.
- Before changing an existing PR/MR, read its current title and description. Preserve fields and manual content the user did not ask to replace.
- Do not fabricate test counts, coverage, commands, links, ticket IDs, or implementation claims.

## Workflow

1. Determine the requested operation: `draft`, `inspect`, `create`, or `update`.
2. Gather facts from the current conversation and available repository evidence. Read-only git commands are allowed when they help understand the change or identify candidate remotes.
3. Load [references/description.md](references/description.md) and prepare the title/body.
4. If the request is only `draft`, return the draft and stop.
5. Resolve the publication target. Require provider, host, repository, source branch, and target branch to be known. If provider/host/repository are not explicit, ask the user instead of guessing. Candidate remotes may be shown as suggestions.
6. Load [references/github.md](references/github.md) for GitHub or [references/gitlab.md](references/gitlab.md) for GitLab.
7. Run the minimal provider preflight: verify the CLI exists and verify authentication for the selected host. Use the installed CLI's `--help` when exact flags differ by version.
8. For `create`, verify that the source branch already exists remotely. If it does not, stop and hand off to the git workflow. Do not push or let an interactive CLI flow push/fork on this skill's behalf.
9. For `create`, check for an existing open PR/MR from the same source branch to the same target repository/branch. If one exists, report it and stop. Do not edit it unless the user explicitly requests `update`.
10. For `update`, inspect the existing PR/MR first. Change only the fields requested by the user. If replacing the description would discard unrelated manual content and the user's intent is not explicit, show the conflict and ask before overwriting.
11. Execute the requested provider operation non-interactively where practical, supplying explicit repository, branches, title, and description.
12. Return the resulting PR/MR URL. If the CLI fails, return the original failure output and do not invent a diagnosis that the CLI did not establish.

## Publication readiness

Treat verification as a publication gate, not a place to advertise failures.

- If the current project/workflow defines required checks and any are known to be failing or incomplete, do not create the PR/MR.
- Do not put failed, skipped, unknown, or not-run checks into the PR/MR description.
- Do not invent a universal test command or require metrics the project does not provide.
- A description may still be drafted before publication readiness is established.

## Existing PR/MR safety

For `create`:

- Existing change request found: report its URL/identifier and stop.
- Never replace its title or body automatically.

For `update`:

- Read current title/body first.
- Preserve fields not requested for change.
- Preserve useful manually written content unless the user explicitly asks to replace the whole description.

## References

- [references/description.md](references/description.md): canonical description structure and verification checklist.
- [references/github.md](references/github.md): GitHub workflow with `gh`.
- [references/gitlab.md](references/gitlab.md): GitLab workflow with `glab`.
