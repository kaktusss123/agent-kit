---
name: git-commit
description: "Create a safe coherent repository checkpoint with protected-branch rules, EVODP ticket extraction, explicit staging, hook enforcement, and concise commit messages."
---

# Git commit

Never commit on `main`, `master`, or `develop`. Never push. Never use `--no-verify`. Never use `git add .` or `git add -A`.

Inspect the current branch, status, and intended diff. Preserve an existing staged set when it is coherent. Otherwise stage only explicit intended paths. Do not stage likely secret files such as `.env`, private keys, or credential files unless the user explicitly identifies a safe tracked fixture.

Extract `EVODP-<number>` from the branch for normal work. If no ticket exists, stop unless ticketless mode was explicitly requested with wording such as `--no-ticket`, `ticketless`, `no ticket`, or `без тикета`.

Use `<type>(EVODP-1234): <description>` or `<type>: <description>` in ticketless mode. Choose `feat`, `fix`, or `chore` from the actual change. Write the description in English, imperative mood, and keep the subject to 20 words or fewer.

Inspect the staged diff before committing. Let hooks run normally. If hooks modify files from the intended set, inspect them, re-stage only that same set, and retry once with the same message. If the retry fails, stop with the real error.

Return the commit id, message, staged file count, and any remaining working-tree changes.
