---
name: git-task
description: "Judgment layer for Git task workspaces: decide task mode vs read-only chat, resolve ticket/branch identity, route single-repo vs multi-repo implementation through managed task worktrees and repository owners. Use before any task-oriented specification or code mutation in a Git repository."
---

# Git task workspaces

Decide whether the conversation is a task; establish its Git identity; route implementation across managed task worktrees and repository owners. Deterministic safety lives in Pi extensions; this skill is judgment only.

## Mandatory references

This skill states policy only. The Pi runtime contracts it relies on are normative, not "see also":

- Before resolving or creating a task workspace, read `references/task-workspace.md`.
- Before dispatching or interacting with repository owners, read `references/repo-owners.md`.

If a required deterministic capability is missing on this install (tool absent, dispatch refused), fail closed: report the task as unsupported. Do not improvise a degraded fallback.

## Task mode or read-only chat

- Ordinary read-only conversation (analysis, questions, code reading) creates no task, no worktree, no fetch, and requires no ticket. A dirty source checkout is analyzed exactly as it is.
- Switch to task mode when the conversation moves to task-oriented specification (`/spec`) or mutation (`/dev` or an explicit change request).

## Identity resolution

Never invent a ticket. Resolve in order:

1. User named a branch → use it exactly; reuse its existing task workspace if one exists.
2. User named a ticket, no branch → find task workspaces whose identity contains the exact ticket key (`KEY-1234`); repo branches are not workspace identity:
   - exactly one → reuse it;
   - several → ask the user which one;
   - none → derive `<type>/<TICKET>_<slug_with_underscores>`; choose `feat`/`fix`/`chore` and a semantic slug from the task intent.
3. Neither → ask the user whether a ticket exists and, if not, whether ticketless work is authorized. Do not state that a ticket is mandatory or raise `missing_ticket` before this question is answered. If the user explicitly approves ticketless work, proceed with a ticketless branch (`<type>/<slug_with_underscores>`); otherwise wait for the ticket. Never invent one.

## Base selection

`base_ref` is allowed only when the user explicitly named the base, a SPEC/task decision fixed it, or an earlier continuation of this same task fixed it unambiguously. Seeing a branch or SHA in `git log`, `git status`, or `origin/<branch>` is Git evidence, not provenance. Never infer a release, hotfix, maintenance, or other product base from context; omit the base and let the deterministic runtime select it. If the runtime reports base ambiguity, ask the user instead of guessing.

## Establish the worktree

Establish one managed worktree per repository that the task will write, through the task-workspace runtime; never treat the primary (source) checkout as the task's write target. Inspect the runtime's self-describing facts about the input repository and never mutate that input checkout. Handle ambiguity by asking, never by forcing.

The primary checkout is never used for task-generated mutation: while a task workspace exists for a repository, the deterministic mutation guard blocks tracked-file writes and mutating git commands aimed outside the managed worktree (typical routing mistakes — not a security boundary), and primary-checkout commits are rejected. This is protection, not an obstacle to route around.

## Canonical workspace and secondary lanes

If this task already has a canonical worktree for a repository, continue there by default. Do not create a secondary lane merely to test separately, deploy, isolate a commit, try another sequence, bypass a blocked Git operation, or obtain a clean branch.

Create a secondary lane only for a real additional branch lane explicitly required by the user or SPEC/task decision: backport/forward-port, or a release/hotfix branch that must coexist with the canonical implementation branch. The canonical worktree remains the default target; name the absolute path explicitly in owner handoffs.

## Git side effects and recovery

Commit, push, deployment, and acceptance are different states. Before an external side effect, check only the prerequisites or SPEC gates explicitly linked to that side effect. An open deployment gate blocks a push that triggers deployment, but does not block an ordinary push for a draft MR; report the specific blocker instead of calling the side effect ready.

A guard block is a routing failure, not permission to repeat the same mutation through `sed`, `cp`, `eval`, Python, or another agent. Manual tracked-file adaptation is allowed only as an explicit implementation decision (for example a conflict or backport), with the reason stated and the resulting diff re-verified.

## /spec

Main owns discovery and specification: the user conversation, product and design decisions, synthesis of evidence, and the canonical specification. Establish identity and the initial repository worktree before substantive analysis. Once the canonical worktree exists, repository evidence comes from the managed worktree — read files and run inspection commands by its explicit path, or root bounded research subagents there. The session's own cwd never changes; the source checkout is no longer repository evidence for this task. Materialize additional repositories lazily as scope demands.

Durable artifacts (`SPEC.md`, `ADR-*.md`, `specs/<repo>.md`) live in the task workspace next to the worktrees; `SPEC.md` is the canonical entrypoint. For multi-repo tasks, `SPEC.md` fixes the cross-repo contract, writable repositories, ownership, dependencies/parallelism, and integration acceptance criteria.

Research subagents are bounded helpers: one explicit question, one boundary, read-only findings synthesized in Main. They never own decisions or the problem.

## /dev

Main is the task controller: it owns task intent, user decisions, orchestration, review, and integration. Repository mutation is performed by RepoOwners rooted in managed task worktrees — for one writable repository dispatch exactly one RepoOwner; for several, one per repository. The execution model is the same at any repo count; what scales is the number of owners, not the workflow.

When implementation begins, reuse the existing canonical worktrees and load the task's `SPEC.md` when present. Before dispatch, fit each owner's scope to its deadline and leave time for a candidate commit plus post-commit verification. If the assignment cannot fit, reduce or sequence the scope instead of relying on the hard cutoff. Pass the chosen `deadlineSec`; the runtime adds the finalization budget to the child prompt, so Main must not duplicate it in the canonical task.

Dispatch owners as parallel calls when repositories are independent, in dependency order otherwise, treating a contract-fixing checkpoint (implementation + local verification yielded) as the barrier before dependents mutate against it. Owners work strictly inside their own worktrees and return contract conflicts to Main instead of resolving them silently. Main does not edit task repositories itself.

Late escalation: Main keeps ownership of the repository whose owner already ran; dispatch an owner only for the newly discovered repository. If the discovery changes the cross-repo contract or architecture, update the specification before further mutation — no ceremonial restart.

## Worker verification reports

Completion ordering (ADR-0002): a `done` outcome describes a committed, settled candidate. Before `report_result(status=done)`, the finished state must be committed as a candidate commit, and the final verification must have run against the repository after that commit was created. Checks run before the commit remain development feedback; they do not replace the post-commit final verification. If verification, hooks, or repair changed repository state after the last commit, that state is a new candidate: commit it and verify it again before yielding.

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

Main performs the final diff/contract review on the settled state after each owner's yield; an interim look while the owner works is advisory only. If that review finds a defect in a worker-owned repository, repair with a fresh owner that first inspects existing state — never by editing another owner's repository directly, and never by steering a settled owner.

After accepting each final-verified committed candidate, Main makes an explicit review decision: whether its own review and verification are enough, or the candidate deserves an independent fresh-context reviewer. For a local, obvious, low-risk change the answer is usually no reviewer — review it in Main and move on. For substantial work the expectation shifts toward the reviewer: a large or wide diff, changes to architecture, contracts, or ownership boundaries, impact across several components, security sensitivity or expensive-to-regress behavior, correctness that ordinary tests cannot convincingly demonstrate, a suspicious or ambiguous owner report, a high cost of error, or an explicit user request. None of these automatically forces a reviewer, but skipping one on a substantial candidate must be a stated decision with a reason, never the default reached by silence.

An independent reviewer is a plain `subagent` spawn rooted at the managed worktree (`cwd=<worktree>`, no `workspace`) with `modelClass=smart`: a fresh session, never the implementing owner, which inherits Main's model and would be reviewing its own work. The assignment carries the goal or the `SPEC.md` path when one exists, the base SHA Main dispatched against and the candidate HEAD from `git_facts`, the worktree path, and what to verify — at minimum intent fidelity to the task/spec, engineering correctness, and regressions or missed failure modes, working per `skill://code-review`. Review is read-only; the reviewer returns a compact verdict: `PASS`, or actionable findings with evidence.

On a substantial FAIL, repair through the existing path: a new owner whose task carries the findings and begins by inspecting current state. Main neither patches the candidate itself nor sends the reviewer to fix what it flagged. After a repair, Main again decides whether another independent round adds value; do not loop mechanically.

A reviewer is never spawned ritually; the same judgment governs a separate fresh-context verifier (`skill://change-verification`) when an acceptance is itself a big independent task.

Delegation follows context and independence — never create committer/branch-fixer/pusher-style microagents to route around broken or blocked tooling. When the runtime tools work, Main calls them directly.

## Checkpoints

When to checkpoint is judgment; mechanics are the runtime's. Commit exact intended paths with hooks run, no blanket staging, no push. Primary-checkout commits happen only as the explicit user-requested manual-source exception. Push only on an explicit user request, as a separate action. The concrete commit contract lives in the git-commit skill and its checkpoint reference.
