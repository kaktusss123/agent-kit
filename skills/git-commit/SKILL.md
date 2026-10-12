---
name: git-commit
description: "Safe repository checkpoint commit policy for implementation workflows and explicit commit requests. Use when an agent must stage and commit a coherent change while enforcing branch and push policy, ticket extraction for any tracker, ticketless mode for personal repositories, concise English commit messages, explicit staging, secret-file exclusions, and repository hooks."
---

# Git commit

Create a checkpoint from the repository state without broadening its scope.

## Division of responsibility

Judgment (model): whether a checkpoint is warranted, where it belongs, the semantic message, ticket policy, and choosing the exact intended path set.

Mechanics (runtime): the `checkpoint_commit` tool enforces exact staging, secret-path rejection, ambiguous-staged detection, hook execution, primary-checkout protection, and post-commit scope verification of the created commit, and reports a structured result. Read `references/checkpoint.md` before the first checkpoint commit in a session (in Claude Code also `references/claude-code/checkpoint.md`, the `agent-kit task commit` binding of the same tool); it is the operative contract for inputs, statuses, and the deferred-hook evidence path. Do not duplicate those guarantees by hand.

The by-hand procedure in this skill is the fallback for repositories outside any managed task workspace (no `checkpoint_commit` target). Everywhere else the runtime tool is the path.

## Hard policy

- Never use raw `--no-verify` (the bash guard blocks it everywhere). The only hook-bypass path is the runtime's deferred hook verification, and the model supplies only evidence for it — never a bypass switch.
- Never use blanket staging such as `git add .` or `git add -A`; stage the exact intended path set.
- Never stage likely secret files such as `.env`, `.env.*`, `*.pem`, `*.key`, or `credentials.json` unless the user explicitly identifies a safe tracked fixture that merely matches the pattern.
- Preserve an existing staged set only when it is unambiguous. If the pre-staged set differs from the intended checkpoint paths, stop and ask instead of silently merging.
- Never push. Pushing is a separate action, performed only on an explicit user request.

## When a checkpoint is appropriate

A checkpoint is a coherent, explainable slice of completed work: implementation plus the verification that observed it, or a deliberate intermediate state that a reviewer or dependent owner can build on. Do not checkpoint unrelated working-tree noise into the same commit; do not split one coherent change into ceremony commits either.

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
3. Commit through `checkpoint_commit` per `references/checkpoint.md`; handle its statuses there. Pass `allow_primary` only for the explicit user-requested primary case.
4. Otherwise (no runtime target): stage only the explicit intended paths, inspect the staged diff, run `git commit -m <message>` letting hooks execute normally, and if hooks modify files from the intended set, re-stage exactly that set and retry once.
5. Confirm the resulting commit id and inspect repository status.

If a commit attempt fails twice, stop with the actual error. A code-validation failure (test, lint, typecheck, format, secret scan, generated-code mismatch, hook that modified the intended files, unknown failure, or a missing tool you could reasonably install) is never deferred — fix it or escalate. Only a hook failure caused by an external prerequisite or availability blocker (per the reference contract) may go through deferred-hook evidence.

## Verification expectations

A checkpoint claims the change works at least as far as it has been observed. Before committing substantive code, run the focused checks that can observe it (tests, typecheck, lint) or record explicitly in the task report that they were not run and why. Deferred-hook commits are, by definition, not fully verified — surface the remaining gap downstream (task report, MR description) as the reference requires.

## Return

Report concise facts: status, branch, commit id, message, ticketless state when applicable, staged file count, and any hook failure or remaining working-tree changes.
