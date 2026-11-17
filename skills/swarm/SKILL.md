---
name: swarm
description: "Coordinate bounded parallel work and reconcile coverage and gaps. Use for a swarm, independent research slices, parallel implementation slices, or an explicitly defined comparison or race; not for choosing among independent attempts at one artifact, use arena."
---

# Swarm

Use parallel work only when the work can be bounded and the coordination cost is justified. For competing complete candidates use `skill://arena`. Read-only work needs no task workspace; writing follows `skill://git-task` and the host binding.

1. Define the observable done condition and output. Choose the shape: partition distinct coverage into named slices, or declare comparison/race arms and their stopping and evaluation rules in advance. State dependencies and required coverage; avoid treating the fastest answer as correct without evidence.
2. Give each worker a bounded assignment, common input revision or exact relevant snapshot, scope, expected evidence and distinct output destination. Explicitly forbid writes and external side effects for read-only workers. Record missing or unavailable input state rather than assuming equivalent snapshots. Choose worker count and models for the task; a named model must resolve exactly, never silently substitute it.
3. For writing, establish the repository's canonical worktree first, then explicitly named managed lanes with separate branches and one owner per physical worktree, including same-repository slices. Assign integration ownership and the destination before dispatch; avoid shared-branch races and overlapping write destinations. Do not use primary checkouts or raw temporary Git worktrees. Dependencies wait for the required committed, verified checkpoint.
4. Delegate using native host mechanisms: Pi `subagent` workspace spawn for writing owners, Claude Code Agent `repo-owner`, or Codex native agents with the controller enforcing ownership. Read-only delegates remain separate and explicitly read-only. In Pi, a RepoOwner child cannot spawn workspace owners: ask Main to coordinate additional lanes rather than replacing them with plain helpers. Missing delegation or an unavailable requested model blocks the affected assignment; report it rather than changing the request. Wait for, or explicitly account for, every worker; a wait timeout is not settlement.
5. Reconcile each required slice or arm against evidence, noting conflicts, failures and uncovered scope. Route any writing integration through the designated owner in its own worktree, then verify the combined result and its interactions. Require the normal candidate commit followed by final verification; no automatic push or destructive lane cleanup.

Return the shape and done condition, input revisions, assignments and destinations, completed/failed/pending coverage, integration evidence, and remaining gaps. Do not claim complete coverage from partial worker reports.
