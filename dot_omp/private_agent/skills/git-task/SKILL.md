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

- `reused` / `attached` / `created` / `created_from_remote` → proceed; inspect the self-describing `inputRepo` facts and never touch that input checkout.
- `base_selection_required` / `remote_selection_required` → ask the user; never guess product branching semantics.
- `branch_in_use` → report which worktree holds the branch and ask; never force or detach.

Base selection contract: `base_ref` is allowed only when the user explicitly named
the base, a SPEC/task decision fixed it, or an earlier continuation of this same
task fixed it unambiguously. Seeing a branch or SHA in `git log`, `git status`, or
`origin/<branch>` is Git evidence, not provenance. Never infer a release, hotfix,
maintenance, or other product base from context; omit `base_ref` and let the
deterministic runtime select it. If the runtime returns `base_selection_required`,
ask the user instead of guessing.

Never create task-generated changes in the primary checkout. The write/edit guard blocks the primary once a task workspace exists for that repository; manual linked worktrees and outside-Git writes stay unblocked.

## Canonical continuation and secondary lanes

If this task already has a canonical worktree for a repository, continue there by
default. Do not create a secondary lane merely to test separately, deploy,
isolate a commit, try another sequence, bypass a blocked Git operation, or obtain
a clean branch.

Create a secondary lane only for a real additional branch lane explicitly required
by the user or SPEC/task decision: backport/forward-port, or a release/hotfix
branch that must coexist with the canonical implementation branch. The canonical
worktree remains the default target; name the absolute path explicitly in owner
handoffs.

## Git side effects and recovery

Commit, push, deployment, and acceptance are different states. Before an
external side effect, check only the prerequisites or SPEC gates explicitly
linked to that side effect. An open deployment gate blocks a push that triggers
deployment, but does not block an ordinary push for a draft MR; report the
specific blocker instead of calling the side effect ready.

A guard block is a routing failure, not permission to repeat the same mutation
through `sed`, `cp`, `eval`, Python, or another agent. Manual tracked-file
adaptation is allowed only as an explicit implementation decision (for example
a conflict or backport), with the reason stated and the resulting diff
re-verified.

## /spec

Establish identity and the initial repository worktree before substantive analysis; analyze the fresh worktree, not the dirty source state. Materialize additional repositories lazily as scope demands. Durable artifacts (`SPEC.md`, `ADR-*.md`, `specs/<repo>.md`) live in the task workspace next to the worktrees; `SPEC.md` is the canonical entrypoint. For multi-repo tasks, `SPEC.md` fixes the cross-repo contract, writable repositories, ownership, dependencies/parallelism, and integration acceptance criteria.

## /dev, single repo

Main implements directly in the managed worktree. If the session still sits in the source checkout, hand the user the exact `/move <worktree-path>` instruction and continue in the same session after relocation.

## /dev, multi repo

Main is the task-level orchestrator. When the task is known to touch several repositories before meaningful mutation begins, every writable repository gets its own repo owner — Main does not keep one of them for itself because the change looks small or first in the dependency DAG. Spawn each owner with the `workspace_agent` tool: `workspace` = the absolute managed worktree path from `ensure_task_repo`, `task` = the complete owner assignment. The owner session is rooted in that worktree — it works with relative paths, sees the repository's own project instructions, and yields a structured envelope (`status`/`summary`/`verification`/`gaps`). Run independent owners as parallel `workspace_agent` calls. After dispatch there is never an automatic fallback: a failed owner returns `partial` or `blocked` with `child_may_have_mutated_repo` — inspect the worktree and repair with a fresh `workspace_agent` invocation that first inspects existing state. Workers change only their own repository, verify locally, and return contract conflicts to Main instead of resolving them silently.

Host-specific owner mechanics (do not mix these into a shared contract):

- **Pi (subagents workspace layer):** the owner profile has no nested delegation — repo-local helpers are part of the owner's own work, never `subagent`/`task` calls. When `workspace_agent` is absent on this install, or a dispatch returns `unsupported` with `dispatched=false` (missing profile entrypoints, refused readiness, extension load failure), fall back to a `subagent op=spawn` owner with `cwd` = the absolute managed worktree path, the task in the prompt, the repository addressed by absolute paths only (reads, writes, `git -C`) — and request the structured report below in the prompt; without the workspace layer it is advisory, not enforced. Terminal owners are retired; repair means a NEW owner (see the RepoOwner run protocol).
- **OMP:** the owner may delegate repo-local helpers via the stock `task` tool (they inherit the same worktree). When `workspace_agent` is unavailable or returns `unsupported` with `dispatched=false`, fall back to a stock `task` owner whose prompt carries the absolute managed worktree path (reads, writes, `git -C`). Retained-owner revival semantics remain OMP-specific.

Dependencies are model judgment, not a scheduler: when repos form a DAG, Main spawns owners in dependency order and treats a contract-fixing checkpoint (implementation + local verification yielded) as the barrier before dependents mutate against it. Workers need not run simultaneously.

Late escalation: Main keeps ownership of the repository it already started; spawn an owner only for the newly discovered repository. If the discovery changes the cross-repo contract or architecture, update the specification before further mutation — no ceremonial restart.

## RepoOwner run protocol (Pi)

Pi-specific — the subagents workspace layer in pi-tuning. The `workspace_agent` dispatch call blocks until `done`, `partial`, `blocked`, or `needs_input`. `needs_input` suspends the owner without finishing the run: answer it with `subagent op=respond` (allowed on RepoOwners); the run resumes under the same deadline — never re-dispatch. A terminal run is announced as a `[workspace_agent completed]` message; it carries the full envelope when the outer status is `done`, while protocol failures (`partial`/`blocked`) carry reason and mutation-risk metadata instead. The notification is not the only API — `workspace_agent(run_id)` returns the same terminal envelope (query-mode also reports an in-progress run as `running`) for the rest of the session. On a RepoOwner the `subagent` tool accepts only `status`, `result`, `respond`, `cancel`; `wait`, `steer`, `follow_up` are rejected with an explanation (the owner's lifecycle events belong to the workspace registry, and steering would bypass the deadline). After a terminal outcome the owner process is retired and its record keeps the original terminal status.

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

Main performs the final diff/contract review on the settled state after each owner's yield; an interim look while the owner works is advisory only. If that review finds a defect in a worker-owned repository, repair with a fresh owner that first inspects existing state — never by editing another owner's repository directly, and on pi never by steering the settled owner (terminal owners are retired; steer/follow_up are rejected by the tool — see the RepoOwner run protocol). OMP exception: a retained owner can be revived in place when the host runtime supports it (exception: the repository Main legitimately owns in the late-escalation case).

A separate reviewer or verifier agent is justified only when independent fresh-context judgment genuinely helps: complex contract, security, concurrency, large blast radius, architectural change, an acceptance that is itself a big independent task, or an explicit user request. Do not spawn them ritually.

Delegation follows context and independence — never create committer/branch-fixer/pusher-style microagents to route around broken or blocked tooling. When the runtime tools work, Main calls `task_status`, `ensure_task_repo`, and `checkpoint_commit` directly.

## Checkpoints

When to checkpoint is judgment; mechanics are the runtime's. Commit through `checkpoint_commit` (exact paths, hooks run, no blanket staging, no push; raw `--no-verify` is blocked everywhere). Primary-checkout commits are blocked by the runtime except the explicit user-requested manual-source commit. Push only on an explicit user request, as a separate action. See the git-commit skill for the deferred hook verification contract.
