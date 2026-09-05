---
name: git-task
description: "Judgment layer for Git task workspaces: decide task mode vs read-only chat, resolve ticket/branch identity, reuse or create managed task worktrees through the task-workspace runtime, and route single-repo vs multi-repo implementation. Use before any task-oriented specification or code mutation in a Git repository."
---

# Git task workspace

Decide whether the conversation is a task; establish its Git identity; materialize managed worktrees through the task-workspace runtime tools (`task_status`, `ensure_task_repo`, `checkpoint_commit`). Deterministic safety lives in the runtime; this skill is judgment only.

## Task mode or read-only chat

- Ordinary read-only conversation (analysis, questions, code reading) creates no task, no worktree, no fetch, and requires no ticket. A dirty source checkout is analyzed exactly as it is.
- Switch to task mode when the conversation moves to task-oriented specification (`/spec`) or mutation (`/dev` or an explicit change request).

## Identity resolution

Never invent a ticket. Resolve in order:

1. User named a branch → use it exactly; reuse its existing task workspace if one exists.
2. User named a ticket, no branch → `task_status`, find task workspaces whose branch contains the exact ticket key (`KEY-1234`):
   - exactly one → reuse it;
   - several → ask the user which one;
   - none → derive `<type>/<TICKET>_<slug_with_underscores>`; choose `feat`/`fix`/`chore` and a semantic slug from the task intent.
3. Neither → ask the user for the ticket. Ticketless branches only on explicit user choice.

## Establish the worktree

`ensure_task_repo(branch, source_path, base_ref?, remote?)` per repository. Handle statuses:

- `reused` / `attached` / `created` / `created_from_remote` → proceed; note `sourceDirty` but never touch it.
- `base_selection_required` / `remote_selection_required` → ask the user; never guess product branching semantics.
- `branch_in_use` → report which worktree holds the branch and ask; never force or detach.

Never create task-generated changes in the primary checkout. The write/edit guard blocks the primary once a task workspace exists for that repository; manual linked worktrees and outside-Git writes stay unblocked.

## /spec

Establish identity and the initial repository worktree before substantive analysis; analyze the fresh worktree, not the dirty source state. Materialize additional repositories lazily as scope demands. Durable artifacts (`SPEC.md`, `ADR-*.md`, `specs/<repo>.md`) live in the task workspace next to the worktrees; `SPEC.md` is the canonical entrypoint. For multi-repo tasks, `SPEC.md` fixes the cross-repo contract, writable repositories, ownership, dependencies/parallelism, and integration acceptance criteria.

## /dev, single repo

Main implements directly in the managed worktree. If the session still sits in the source checkout, hand the user the exact `/move <worktree-path>` instruction and continue in the same session after relocation.

## /dev, multi repo

Main is the task-level orchestrator. Spawn one repo owner per writable repository with `workspace: <managed worktree path>` so the child is a full session rooted in its repo. Workers change only their own repository, verify locally, and return contract conflicts to Main instead of resolving them silently. After workers land, Main runs cross-repo verification itself (or spawns an independent verifier when genuinely useful).

Late escalation: Main keeps ownership of the repository it already started; spawn an owner only for the newly discovered repository. If the discovery changes the cross-repo contract or architecture, update the specification before further mutation — no ceremonial restart.

## Checkpoints

When to checkpoint is judgment; mechanics are the runtime's. Commit through `checkpoint_commit` (exact paths, hooks run, no blanket staging, no push). Primary-checkout commits are blocked by the runtime except the explicit user-requested manual-source commit. Push only on an explicit user request, as a separate action.
