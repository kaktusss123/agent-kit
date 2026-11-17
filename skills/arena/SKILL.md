---
name: arena
description: "Compare independent attempts at the same task against a fixed rubric, select a coherent basis, and verify the result. Use for an arena, competing designs, or multiple candidate implementations; not for splitting distinct coverage."
---

# Arena

Use independent attempts when meaningful alternatives are worth their coordination cost. For partitioned coverage use `skill://swarm`. Read-only analysis needs no task worktree; a writing arena follows `skill://git-task` and the applicable host binding.

1. Fix the shared brief, constraints, observable acceptance criteria and comparison rubric before receiving attempts. Identify the exact input revision or snapshot and any relevant uncommitted state; if a common snapshot cannot be supplied safely, report the limitation instead of comparing unlike inputs. Choose a useful number of attempts and any requested models explicitly; do not require model diversity or silently substitute an unavailable named model.
2. Assign the same problem independently, without showing other candidates' results. Specify boundaries, expected artifact, evidence, and distinct output destinations. For read-only attempts forbid mutation and external side effects. For writing attempts establish the repository's canonical worktree first, then explicit named managed lanes with separate branches and one owner per physical worktree; identify the integration owner and destination before dispatch. Never create raw temporary Git worktrees or write in the primary checkout.
3. Use the host's native delegation: Pi `subagent` (workspace spawn for writing owners), Claude Code Agent (`repo-owner` for writing), or Codex native agents (owner assignments per its binding). In Pi, a RepoOwner child cannot spawn workspace owners: ask Main to coordinate additional lanes rather than replacing them with plain helpers. If the required delegation or an exact requested model is unavailable, report the affected attempt blocked; do not silently replace it. Drain or account for every attempt, including failures and unfinished work.
4. Compare completed candidates against the original rubric and actual evidence. Identify uncertainties and select a coherent basis with reasons; do not mechanically combine incompatible pieces. An independent read-only judge is optional, not a substitute for checking evidence.
5. For writing, route selection and any adaptation through the designated integration owner in its own managed worktree; Main and reviewers do not edit another owner's tree. Verify the integrated result against the fixed criteria, including interaction between incorporated pieces. Apply the normal committed-candidate and post-commit verification gates; do not push or remove lanes by inference.

Return the rubric, inputs/revisions, candidate destinations and outcomes, selection rationale, integrated verification, and unresolved gaps. For read-only work return the chosen analysis and supporting evidence without claiming a committed result.
