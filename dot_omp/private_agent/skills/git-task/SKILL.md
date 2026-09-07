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
2. User named a ticket, no branch → `task_status`, find task workspaces whose `key` (the workspace directory name, the flattened branch) contains the exact ticket key (`KEY-1234`); repo branches are reported per repository and are not the workspace identity:
   - exactly one → reuse it;
   - several → ask the user which one;
   - none → derive `<type>/<TICKET>_<slug_with_underscores>`; choose `feat`/`fix`/`chore` and a semantic slug from the task intent.
3. Neither → ask the user whether a ticket exists and, if not, whether ticketless work is authorized. Do not state that a ticket is mandatory or raise `missing_ticket` before this question is answered. If the user explicitly approves ticketless work, proceed with a ticketless branch (`<type>/<slug_with_underscores>`); otherwise wait for the ticket. Never invent one.

## Establish the worktree

`ensure_task_repo(branch, source_path, base_ref?, remote?)` per repository. Handle statuses:

- `reused` / `attached` / `created` / `created_from_remote` → proceed; note `sourceDirty` but never touch it.
- `base_selection_required` / `remote_selection_required` → ask the user; never guess product branching semantics.
- `branch_in_use` → report which worktree holds the branch and ask; never force or detach.

Base selection contract: use `base_ref` only when the user explicitly named the base, or when a previous run fixed it for this task. Never infer a base from product context (a release, hotfix, or maintenance branch that "looks right") — let the deterministic runtime policy decide, and when it returns `base_selection_required`, ask the user.

Never create task-generated changes in the primary checkout. The write/edit guard blocks the primary once a task workspace exists for that repository; manual linked worktrees and outside-Git writes stay unblocked.

## Secondary lanes (backport / release branches)

One repository may need several branches inside one logical task (e.g. `hotfix/*` from a release plus `fix/*` from develop). Materialize each additional lane with `ensure_task_repo(task: <canonical task identity>, branch: <lane branch>, slot: <lane name>, base_ref: <explicit base>)`:

- The lane becomes a sibling `<repo>__<slot>` worktree inside the same canonical task workspace — no second task workspace, no manifest.
- Never auto-create lanes; they appear only on explicit need (user request or an explicit task requirement).
- The lane's branch and base come from the user or the task specification; on ambiguity, ask.
- The canonical worktree stays the default target; name the lane's absolute worktree path explicitly in every owner handoff.

## /spec

Establish identity and the initial repository worktree before substantive analysis; analyze the fresh worktree, not the dirty source state. Materialize additional repositories lazily as scope demands. Durable artifacts (`SPEC.md`, `ADR-*.md`, `specs/<repo>.md`) live in the task workspace next to the worktrees; `SPEC.md` is the canonical entrypoint. For multi-repo tasks, `SPEC.md` fixes the cross-repo contract, writable repositories, ownership, dependencies/parallelism, and integration acceptance criteria.

## /dev, single repo

Main implements directly in the managed worktree. If the session still sits in the source checkout, hand the user the exact `/move <worktree-path>` instruction and continue in the same session after relocation.

## /dev, multi repo

Main is the task-level orchestrator. When the task is known to touch several repositories before meaningful mutation begins, every writable repository gets its own repo owner — Main does not keep one of them for itself because the change looks small or first in the dependency DAG. Spawn each owner with the `workspace_agent` tool: `workspace` = the absolute managed worktree path from `ensure_task_repo`, `task` = the complete owner assignment. The owner session is rooted in that worktree — it works with relative paths, sees the repository's own project instructions, may delegate repo-local helpers via the stock `task` tool (they inherit the same worktree), and yields a structured envelope (`status`/`summary`/`verification`/`gaps`). Run independent owners as parallel `workspace_agent` calls. Only when `workspace_agent` returns `unsupported` with `dispatched=false` (required public SDK capability missing) fall back to a stock `task` owner whose prompt carries the absolute managed worktree path and which addresses its repository by absolute paths only (reads, writes, `git -C`). After dispatch there is never an automatic fallback: a failed owner returns `partial` or `blocked` with `child_may_have_mutated_repo` — inspect the worktree and repair with a fresh `workspace_agent` invocation that first inspects existing state. Workers change only their own repository, verify locally, and return contract conflicts to Main instead of resolving them silently.

Dependencies are model judgment, not a scheduler: when repos form a DAG, Main spawns owners in dependency order and treats a contract-fixing checkpoint (implementation + local verification yielded) as the barrier before dependents mutate against it. Workers need not run simultaneously.

Late escalation: Main keeps ownership of the repository it already started; spawn an owner only for the newly discovered repository. If the discovery changes the cross-repo contract or architecture, update the specification before further mutation — no ceremonial restart.

## Worker verification reports

Before yielding, a repo owner returns a compact structured report (JSON, no raw test output):

```json
{
  "status": "done | partial | blocked",
  "summary": "one paragraph",
  "changed_scope": ["paths or areas"],
  "verification": [
    { "check": "uv run pytest tests/dp_user_plane_api/trino -q", "cwd": "<worktree>", "result": "pass | fail | blocked" }
  ],
  "gaps": ["what was not run or could not run, and why"],
  "contract_conflicts": ["disagreements with SPEC.md, if any"]
}
```

Main trusts this report and does not mechanically repeat local worker checks. Main re-runs checks only when the report is missing or incomplete, repository state changed after the check, a result looks suspicious, or the check is part of integration acceptance.

## Review and repair

Main performs the final diff/contract review on the settled state after each owner's yield; an interim look while the owner works is advisory only. If that review finds a defect in a worker-owned repository, Main steers or revives the same owner to fix and re-verify — Main does not edit another owner's repository directly (exception: the repository Main legitimately owns in the late-escalation case).

A separate reviewer or verifier agent is justified only when independent fresh-context judgment genuinely helps: complex contract, security, concurrency, large blast radius, architectural change, an acceptance that is itself a big independent task, or an explicit user request. Do not spawn them ritually.

Delegation follows context and independence — never create committer/branch-fixer/pusher-style microagents to route around broken or blocked tooling. When the runtime tools work, Main calls `task_status`, `ensure_task_repo`, and `checkpoint_commit` directly.

## Checkpoints

When to checkpoint is judgment; mechanics are the runtime's. Commit through `checkpoint_commit` (exact paths, hooks run, no blanket staging, no push; raw `--no-verify` is blocked everywhere). Primary-checkout commits are blocked by the runtime except the explicit user-requested manual-source commit. Push only on an explicit user request, as a separate action. See the git-commit skill for the deferred hook verification contract.
