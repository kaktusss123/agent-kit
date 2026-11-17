---
name: pr-babysitter
description: "Watch and gate in-scope GitHub PRs or GitLab MRs, checks and reviews; coordinate repairs, merging, and deployment only as requested. Use when: watching a single change or a fleet, handling CI and review feedback, merging in dependency order, or verifying an authorized deployment. Not for: reviewing a single MR from a link; use skill://lazy-mr-review."
---

# PR babysitter

Watch the changes and gates the user actually named. A single PR/MR or a run without deployment is valid; do not infer either a fleet or deployment from this skill. Publication, push, merge, and deployment are separate actions and require their own authority. An explicitly assigned full-send mode grants the scoped normal push, publication, feedback and merge chain; full-stop grants the same chain except merge and the prohibited actions below. Apply `skill://full-send`, not the name appearing in quoted text or background context. Neither mode grants unrelated deployment or production changes.

## 0. Intake

Discover obtainable facts from the repository, forge and configuration before asking: in-scope repos and changes, target branches, deadlines if any, provider and merge conventions, required checks and review policy, current heads, author activity, and whether a push or merge triggers deployment. Ask only for a genuinely unavailable capability, an unresolved decision outside delegated ordinary choices, or permission outside the assignment; do not re-ask for an existing grant. No deadline means no invented deadline.

Distinguish confirmed absence of configured hosted CI from unknown policy or an empty transient result. No configured CI is not a green pipeline; unknown or missing required checks are blockers. Do not wait for a review bot the project does not use.

When deployment is requested or can be triggered by an authorized action, establish its trigger, production scope and consequences before advancing. An ungranted production action is a blocker, including one triggered automatically by push or merge. For an authorized deployment, discover how to list live workloads, stop one gracefully, contact authors, and verify revision, health and a smoke path. If a necessary seam remains unavailable, leave that action untouched and report the blocker. Skip deployment-specific steps when no deployment is requested or triggered.

Use `skill://git-task` managed worktrees and owners for repository writes and repair; never hand-edit another owner's tree or create raw temporary writing clones. Reviews are read-only on a fixed snapshot. Respect the user's in-work branches and live authors, regardless of mode.

## 1. Watch and review

Use the actual GitHub or GitLab provider and repository conventions throughout. Watch only in-scope changes and their dependencies. Where supported, use bounded native waits to continue observing checks and feedback; if safe waiting is unavailable, report the concrete blocker rather than inventing wake/resume support.

For each candidate, record exact base and head, inspect the full changed files and relevant surrounding contracts, and review independently with `skill://code-review`. For coupled producer/consumer changes, review both directions. Run targeted checks on the candidate when feasible; assert imports resolve inside the intended checkout. Label unproven suspicions as such. Never merge with verified material blockers or outstanding human change requests.

Use the configured native reviewer role, or the exact model explicitly selected by the user. A failed, unavailable, rate-limited, or missing reviewer is not approval and does not authorize silent model substitution. An explicitly requested review-loop uses the bounded mode in `skill://code-review`; do not nest loops for council participants.

## 2. Repair and author coordination

A branch tip recently moved by another author indicates a live author: do not push to that branch; coordinate through an available author channel instead. The assignment's own known pushes are not evidence of another live writer. If the user says work is still in progress, hands off. A stale display alone does not prove an author is active or inactive. Before any push, inspect the current remote head and author activity; reassess if either changed. Route repairs to a fresh managed owner inspecting settled state. Use focused regression evidence and candidate verification after its commit.

Normally do not force-push. An explicitly authorized full-send or full-stop assignment may rebase and push its own task branch with `--force-with-lease` tied to the previously observed remote head only when the assignment owns that branch and no other live writer will be overwritten. A failed lease requires reassessment, never an unconditional retry. Never force a shared or other person's branch, bypass protections, or override live-author safeguards.

## 3. Checks and feedback

Classify failures before acting, not by blind reruns. Read the actual failing step and reproduce deterministic failures locally through the managed owner. A single justified rerun can test a suspected flake; a repeated failure needs investigation. Intentional error-path output is not itself a failed check. Establish pre-existing failures against the actual target base rather than assuming them away. Read `references/known-traps.md` for date-dependent end-to-end failures. After conflict resolution, check cross-parent semantics and rerun relevant tests.

Required checks must apply to the actual candidate and target base. Failed, missing, unknown, or stale required checks are not a pass; a review score cannot override them. Re-read head, base, checks, review and mergeability before advancing, and re-evaluate when either revision changes. Handle authorized feedback only after verifying it, and confirm any publication or resolution succeeded.

## 4. Merge or stop

Full-stop never merges, enables auto-merge, enters a merge queue, pushes the default branch, bypasses protections, or delegates those actions. It does authorize inspecting and disabling existing auto-merge or removing this in-scope change from a queue to preserve the no-merge outcome. Inspect and verify those states before every push and handoff; if safe prevention is impossible, stop before advancing a potentially auto-merging head. Do not change repository-wide automation.

For an authorized merge, require applicable checks, current independent review, no valid open blockers or human change requests, and production consequences within scope. Match the expected head where the forge supports it; re-check on movement. Merge in dependency order through normal provider policy, preserving repository conventions including GitLab squash requirements. Never bypass branch protections. Preserve explicit merge windows/deadlines. If a target push cancels an earlier deploy run, merge sequentially when each deployed revision must be verified; otherwise verify the final resulting revision, not a superseded run. A queued or auto-enabled change is not merged: continue bounded observation where supported, then confirm the forge reports `MERGED` at the accepted head and verify the resulting revision/content. Do not claim success if someone else changed or merged the candidate unexpectedly.

## 5. Deployment and report

Only when deployment is requested and authorized, protect live workloads: wait for active authors and workloads, coordinate, and stop only finished lingering workloads through the established graceful seam. Confirm the blast radius before an action that restarts services. Watch the deploy to a terminal state, verify the deployed revision and health, run the agreed smoke, and report failures or rollback rather than silently accepting an old revision.

Re-read live state for each in-scope change: head/base, checks, reviews, mergeability, and auto-merge/queue state. For full-stop also check open/not-draft as appropriate; report `READY`, `WAITING FOR REQUIRED APPROVAL`, or `BLOCKED` honestly. Say only human approval remains only when all other gates have passed; if someone else merged it, report the actual state instead of claiming the no-merge outcome. Report findings and dispositions, checks including confirmed no CI versus unknown, author coordination, actual merges/deployments and remaining blockers. Never report a deployment or green pipeline that did not happen.

A filled-in example of deployment seams is in `references/example-profile.md`.
