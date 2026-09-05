---
name: git-commit
description: "Safe repository checkpoint commit policy for implementation workflows and explicit commit requests. Use when an agent must stage and commit a coherent change while enforcing branch and push policy, ticket extraction for any tracker, ticketless mode for personal repositories, concise English commit messages, explicit staging, secret-file exclusions, and repository hooks."
---

# Git commit

Create a checkpoint from the repository state without broadening its scope.

## Division of responsibility

Judgment (model): whether a checkpoint is warranted, the semantic message, ticket policy, and choosing the intended path set.

Mechanics (runtime): when the `task-workspace` extension is available, commit through the `checkpoint_commit` runtime — it enforces exact staging, secret-path rejection, ambiguous-staged detection, hook execution, single retry on hook-modified files, and primary-checkout protection. Do not duplicate those guarantees by hand; call the runtime and read its structured result.

When the runtime is unavailable, apply the behavioral rules below by hand.

## Hard policy

- Never use `--no-verify`.
- Never use blanket staging such as `git add .` or `git add -A`.
- Never stage likely secret files such as `.env`, `.env.*`, `*.pem`, `*.key`, or `credentials.json` unless the user explicitly identifies a safe tracked fixture that merely matches the pattern.
- Preserve an existing staged set only when it is unambiguous. If the pre-staged set differs from the intended checkpoint paths, stop and ask instead of silently merging.
- Never push.

## Branch and checkpoint location

- Task work (anything driven by this workflow) commits in the managed task worktree on the task branch — never in the primary (source) checkout.
- Committing in a primary checkout is allowed only when the user explicitly asked for it in this conversation (for example: "я руками поправил dotfiles, закоммить") — and only for the user's own manual changes, never for task-generated work.
- Never commit on `main`, `master`, or `develop` on your own initiative. If the work has no task branch and the user did not explicitly name a target branch, establish one first (`skill://git-task`) instead of committing to the default branch.

## Ticket and message

Extract a ticket key — any uppercase `KEY-<number>` such as `EVODP-1234` — from the branch name, the user request, or the parent task.

If no ticket is found, decide by repository context:
- Ticket prefixes are the norm in recent subjects (`KEY-123:` style) → ticketed repo: stop with `missing_ticket` unless the user explicitly chose ticketless.
- Otherwise → ticketless: commit without a ticket.

Ticketless mode is explicit when the user or parent task says `--no-ticket`, `ticketless`, `no ticket`, or `без тикета`.

Use:
- with ticket: `<type>(KEY-1234): <description>`
- ticketless: `<type>: <description>`

Choose `fix`, `feat`, or `chore` from the branch prefix and actual change. Prefer `chore` for maintenance, refactoring, docs, and framework work that is not a product feature or bug fix.

Write the description in English, imperative mood, focused on what changed. Keep the complete commit subject at 20 words or fewer.

## Procedure

1. Decide whether a checkpoint is warranted now, and where it belongs (task worktree vs explicit user-requested primary commit).
2. Inspect `git status` and the diff needed to understand the intended checkpoint; select the exact intended paths.
3. Via `checkpoint_commit` when available: pass `repo`, `paths`, `message` (plus `allow_primary: true` only for the explicit user-requested primary case). Handle its statuses: `primary_commit_blocked`, `secret_path_rejected`, `ambiguous_staged`, `path_outside_repo`, `commit_failed`.
4. Otherwise by hand: keep an unambiguous staged set or stage only explicit intended paths, inspect the staged diff, run `git commit -m <message>` letting hooks execute normally, and if hooks modify files from the intended set, re-stage exactly that set and retry once.
5. Confirm the resulting commit id and inspect repository status.

If the second attempt fails, stop with the actual error. Do not bypass hooks.

## Return

Report concise facts: status, branch, commit id, message, ticketless state when applicable, staged file count, and any hook failure or remaining working-tree changes.
