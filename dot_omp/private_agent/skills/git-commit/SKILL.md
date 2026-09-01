---
name: git-commit
description: "Safe repository checkpoint commit policy for implementation workflows and explicit commit requests. Use when an agent must stage and commit a coherent change while enforcing protected-branch rules, EVODP ticket extraction, ticketless mode, concise English commit messages, explicit staging, secret-file exclusions, and repository hooks."
---

# Git commit

Create a checkpoint from the repository state without broadening its scope.

## Hard policy

- Never commit on `main`, `master`, or `develop`.
- Never push as part of this workflow.
- Never use `--no-verify`.
- Never use blanket staging such as `git add .` or `git add -A`.
- Never stage likely secret files such as `.env`, `.env.*`, `*.pem`, `*.key`, or `credentials.json` unless the user explicitly identifies a safe tracked fixture that merely matches the pattern.
- Preserve an existing staged set. If nothing is staged, select explicit paths from the intended change.

These are behavioral rules until a runtime hook enforces them mechanically.

## Ticket and message

Read the current branch before staging.

For normal work, extract `EVODP-<number>` from the branch name. If it is absent, stop with `missing_ticket` unless ticketless mode was explicitly requested.

Ticketless mode is explicit when the user or parent task says `--no-ticket`, `ticketless`, `no ticket`, or `без тикета`.

Use:
- with ticket: `<type>(EVODP-1234): <description>`
- ticketless: `<type>: <description>`

Choose `fix`, `feat`, or `chore` from the branch prefix and actual change. Prefer `chore` for maintenance, refactoring, docs, and framework work that is not a product feature or bug fix.

Write the description in English, imperative mood, focused on what changed. Keep the complete commit subject at 20 words or fewer.

## Commit procedure

1. Confirm the protected-branch rule.
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
