---
name: full-send
description: "Use when the user explicitly assigns a task in full send or full-send mode to carry it through merge, or in full stop or full-stop mode to publish it ready for review without merging. Natural language is sufficient; discussion or quotation of these names is not an assignment."
---

# Full send and full stop

An explicit mode assignment grants the actions below only for the named task. For example, "Implement the change, full send" and "Prepare this PR, full stop" invoke their respective modes; quoting those phrases, discussing the modes, or authoring a skill about them does not. Do not use a keyword as an authorizer. A delegate receives only its explicit limited assignment, not the parent's whole grant from background context. If intent or scope is genuinely ambiguous, ask.

Resolve ordinary product and technical choices within the agreed goal and constraints independently, using conservative reversible choices and repository, forge and configuration evidence. Two reasonable implementations are not by themselves a reason to ask. Ask only for an unavailable capability or access, irreducible ambiguity in the goal, mandatory contract/base or compatibility, an ungranted risk, required behavior that cannot be proved, or an action outside the grant. Do not ask again for an already authorized action. Resolve identity and base through `skill://git-task`; never invent a ticket or base. An explicit mode assignment permits ticketless work if no ticket is supplied and the repository does not require one; it cannot waive a mandatory tracker policy or resolve an ambiguous product/release base.

## Shared chain and boundaries

1. Finish the assigned implementation through managed worktree owners (`skill://git-task`, `skill://implementation`). Preserve one live owner per physical worktree; do not hand-edit another owner's tree or create raw temporary writing worktrees. Commit the candidate using `skill://git-commit` and verify the final candidate after that commit. Use `skill://verification-design` for direct proof. Necessary isolated local tests, app launch, browser use and screenshots for this task need no repeated permission; stronger system and host restrictions and project test procedures still apply.
2. Obtain independent review with `skill://code-review`; use its review-loop when available, or `skill://council` when explicitly requested or configured. Evaluate findings against fixed intent and evidence; repair through a fresh owner, verify the new committed candidate and re-review as needed. Do not expand scope to appease a reviewer. A timeout, missing response or exhausted review budget is not approval.
3. Push the task branch, create or update its PR/MR via `skill://change-request`, and handle relevant CI and review feedback. The grant covers scoped technical replies and resolving threads only after checking each finding and confirming publication succeeded; it does not cover unrelated public messages. Preserve unrelated manual description content and provider conventions, including GitLab squash requirements. Review, publication and merge are distinct gates even when all are granted.
4. Inspect the actual forge policy and consequences before push or merge, including automatic production deployment. No production action, data deletion, credential expansion, unrelated repository or branch, active agent installation, or deployment beyond the requested goal is granted. An ungranted production consequence blocks the triggering action. Follow stronger system and host restrictions; no protection bypass, `--admin`, or raw `--no-verify`.

After a rebase, a lease push is permitted only on the assignment's own branch, when no other live writer is overwritten, using `--force-with-lease` tied to the previously observed remote head. If the lease fails, reassess; never retry as an unconditional force push. Do not force shared or other branches.

## Readiness gate

Direct verification and independent review must cover the actual candidate and intended target base. Recheck when head or base changes; match expected head on forge operations when supported. Required checks must apply to that candidate and base; failed, missing, unknown or pending required checks, verified unresolved blocking findings and human change requests block readiness regardless of review score. Distinguish an established absence of configured hosted CI from unknown policy or a transient empty result; never claim a green pipeline when none ran. Wait only for checks and reviewers actually required by the project, not hardcoded bots. Respect branch protection, the forge's mergeability result and repository merge conventions.

## Full send

This mode additionally authorizes merging the in-scope PR/MR through normal forge policy once all gates pass, including a merge queue or auto-merge where required. Continue through relevant checks and feedback using a supported bounded native wait when available; do not pretend a host has a watcher or resume capability it lacks. If no safe way to continue exists, report the concrete blocker rather than implying completion. Finish only when the forge confirms `MERGED` at the accepted head; queued or auto-enabled is not merged. Verify resulting revision and content and any explicitly requested deployment. Report the PR/MR, accepted head, merged revision, proof, decisions and any remaining risk.

## Full stop

Never merge, enable auto-merge, enter a merge queue, push the default branch, bypass protections, or delegate any of these actions. Inspect existing auto-merge and queue state before advancing; this mode authorizes disabling auto-merge or removing this in-scope PR/MR from a queue. Verify the safe state before each push and at handoff. If automatic merging cannot be prevented safely, stop before advancing a potentially auto-merging head. Do not edit repository-wide automation.

Re-read live head, base, checks, reviews, mergeability, open/not-draft state as appropriate, auto-merge and queue at handoff. Report `READY`, `WAITING FOR REQUIRED APPROVAL` only if every other relevant gate passed, or `BLOCKED` with evidence and the next decision. If someone else merged it, report the actual state rather than claiming a no-merge outcome.

Adapted from [tstack full-send and full-stop](https://github.com/t3dotgg/tstack/tree/11e37a74d0a6868c121cd0910ab2b3bd9873b92a/skills), Copyright (c) 2026 Theo Browne, MIT; see [LICENSE](LICENSE).
