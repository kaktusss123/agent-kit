---
description: Create one safe git commit with a conventional message and pre-commit hooks
agent: committer
subtask: true
---

# Commit Command

Create exactly one git commit in the current repository following the git-commit skill workflow.

## Inputs

- `$ARGUMENTS` - Optional short description for the commit message. Pass `--no-ticket` (or include `ticketless`, `no ticket`, `без тикета`) to skip the EVODP ticket requirement for framework development or other ticketless work.

## Workflow

All commit rules, message format, and execution steps are defined in the `git-commit` skill.

The `committer` subagent will:

1. Check branch safety (block main/master/develop)
2. Inspect staged and unstaged changes
3. Require a valid `EVODP-<number>` ticket in the branch name, unless ticketless mode is requested via `$ARGUMENTS`
4. Stage only relevant non-sensitive files when needed
5. Build conventional commit message: `<type>(EVODP-1234): <description>` (or `<type>: <description>` in ticketless mode)
6. Execute commit with pre-commit hooks
7. Retry once if hooks modify files
8. Return structured status report

If `$ARGUMENTS` is provided, it will be used as the commit description (with any `--no-ticket` / ticketless trigger phrase stripped). Otherwise, the description will be derived from the git diff.
