---
name: git-commit
description: "Safe repository checkpoint commit policy for implementation workflows and explicit commit requests. Use when an agent must stage and commit a coherent change while enforcing branch and push policy, ticket extraction for any tracker, ticketless mode for personal repositories, concise English commit messages, explicit staging, secret-file exclusions, and repository hooks."
---

# Git commit

Create a checkpoint from the repository state without broadening its scope.

## Hard policy

- Never use `--no-verify`.
- Never use blanket staging such as `git add .` or `git add -A`.
- Never stage likely secret files such as `.env`, `.env.*`, `*.pem`, `*.key`, or `credentials.json` unless the user explicitly identifies a safe tracked fixture that merely matches the pattern.
- Preserve an existing staged set. If nothing is staged, select explicit paths from the intended change.

These are behavioral rules until a runtime hook enforces them mechanically.

## Branch and push

Before staging, read the current branch and the last 20 commit subjects of the default branch (`git log --format=%s -20 <default-branch>`).

Default: never commit on `main`, `master`, or `develop`, and never push. Two exceptions:

- The user explicitly requested committing on this branch or pushing in this conversation.
- The default branch carries direct history: plain subjects, no `Merge pull request ...` entries and no squash suffixes like `(#123)`. Then committing on it is allowed, but pushing still requires an explicit user request.

If neither exception applies, create a work branch and leave publishing to the repository's normal flow.

## Ticket and message

Extract a ticket key — any uppercase `KEY-<number>` such as `EVODP-1234` — from the branch name, the user request, or the parent task.

If no ticket is found, decide by repository context:
- Ticket prefixes are the norm in the sampled subjects (most carry a `KEY-123:` style prefix) → ticketed repo: stop with `missing_ticket` unless the user explicitly chose ticketless.
- Otherwise → ticketless: commit without a ticket.

Ticketless mode is explicit when the user or parent task says `--no-ticket`, `ticketless`, `no ticket`, or `без тикета`.

Use:
- with ticket: `<type>(KEY-1234): <description>`
- ticketless: `<type>: <description>`

Choose `fix`, `feat`, or `chore` from the branch prefix and actual change. Prefer `chore` for maintenance, refactoring, docs, and framework work that is not a product feature or bug fix.

Write the description in English, imperative mood, focused on what changed. Keep the complete commit subject at 20 words or fewer.

## Commit procedure

1. Confirm the branch and push policy.
2. Inspect `git status` and the diff needed to understand the intended checkpoint.
3. Keep an existing staged set, or stage only explicit intended paths.
4. Inspect the staged diff and ensure it is one coherent checkpoint with no accidental files or secrets.
5. Build the message from the actual staged change and ticket policy.
6. Run `git commit -m <message>` and let hooks execute normally.
7. If hooks modify files from the selected set, inspect the modifications, re-stage only that same intended set, and retry once with the same message.
8. Confirm the resulting commit id and inspect repository status.

If the second commit attempt fails, stop with the actual error. Do not bypass hooks.

## Return

Report concise facts: status, branch, commit id, message, ticketless state when applicable, staged file count, and any hook failure or remaining working-tree changes.
