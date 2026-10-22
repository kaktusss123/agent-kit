---
name: pr-babysitter
description: "Overnight/shift gatekeeping over PRs authored by a fleet of parallel agents: watch open PRs and CI to a deadline, review each PR with fresh subagents, repair red CI, merge in dependency order, and deploy safely while other agents keep working — without killing live workloads the deploy would restart. Use when the user asks to 'watch the PRs', 'merge everything by morning', 'deploy while the agents run', or hands over repos whose agents are still working and a deploy would restart the service underneath them."
---

# PR babysitter

A deploy restarts a service and can kill the workloads running on it. Your
job: everything the user asked for is merged, deployed and verified by the
deadline, and nothing still alive gets murdered on the way.

## 0. Intake — resolve the seams before the first watch cycle

Generic facts: repos in scope (only these), deadlines (typically "CI green by
T1, merged after, deployed and verified by T2"), PR/merge conventions of each
repo, repos without CI (merge has no gate; order only by dependencies).

Then resolve the **environment seams** — every later section talks through
them. Ask the user at intake (he is usually awake when he hands you the
shift); a seam that cannot be resolved degrades that section, never silently
assumes a default:

| Seam | Question | Used by |
| --- | --- | --- |
| deploy trigger | what makes a deploy happen (green push to main, CI job, manual script) and is it automatic? | §5, §6 |
| blast radius | how to LIST the live workloads a deploy would kill (HTTP API, kubectl, ssh+systemctl, process table) | §1, §5 |
| graceful stop | how to stop ONE workload without losing its record/state | §1, §5 |
| author channel | how to message a still-working author agent (chat, API steer, PR comment) — often none | §3 |
| verification surface | how to observe the deployed revision and its health (health endpoint, deploy job status, version file) + a cheap end-to-end smoke | §6 |

If the deploy kills nothing (static site, library), the blast-radius sections
degenerate to "verify the deploy" — skip them.

The user's own checkouts and agent worktrees are never touched: work only in
fresh `/tmp` clones. If the user goes to sleep: no questions, full autonomy;
genuinely unresolvable → leave that piece untouched and report it.

## 1. Watch loop (until T1)

Every ~10 min, bounded sleeps:

- New PRs in scope (`gh pr list` per repo) → open a review per PR (§2).
- CI status per PR; red → triage (§4).
- Branch tips of open PRs: a tip that moved recently means the author agent
  is ALIVE — never push to that branch, coordinate instead (§3).
- Blast radius (via the seam): a workload with recent activity is WORKING —
  wait it out. A status display claiming "working" with hours-stale activity
  may be a dead display: the branch tip on the forge is the ground truth of
  author liveness, status displays are not.
- A finished workload that lingers can be stopped gracefully (via the seam)
  during the merge window — not during the watch.

## 2. Review each PR

Fresh subagent per PR (or one for a coupled producer/consumer pair — review
cross-repo contracts together, both directions). Prompt essentials:

- Isolated clone in `/tmp`, `git checkout --detach <exact head SHA>`, read FULL
  changed files (not just hunks), diff against the base branch.
- `skill://lazy-mr-review` supports both GitLab and GitHub natively; no
  publication to the PR at all — findings go to chat only.
- Evidence by execution: targeted test suites at the SHA; assert imports
  resolve inside the checkout; label static suspicions `static`, unproven
  `conditional`.
- Severity ladder: blocker / major (must fix before merge) / minor / suggestion.
- Model fallback: if the review subagent dies on a provider rate limit,
  respawn on another model class.

Never merge with an open blocker/major from a review you trust.

## 3. Repair etiquette on agent-owned branches

- Fetch the branch tip right before pushing; if it moved, rebase your commits
  onto the new tip. Never force-push.
- Prefer letting the LIVE author self-repair (they watch their own CI). If an
  author channel exists, send a factual steer (root cause, your commit SHA,
  "don't duplicate") instead of racing it. A queued steer beats a push race.
- Your commits: English, scoped, state the root cause in the message.
  Red-check regression tests (temporarily revert the fix, prove the test
  fails, restore).
- If the user says the PR is still in work — hands off entirely.

## 4. CI failure triage

Classify before acting; never blind-rerun:

- Deterministic → read the failing step's real error (the check name + the
  thrown line, not the summary), reproduce locally in the /tmp clone, fix.
- Flaky (passes locally / failed once on CI / known-noise lines) → one rerun
  with a stated reason; a second failure means treat as deterministic.
- Pre-existing on main → prove by running the same suite on a pristine
  checkout of main; then it is out of scope for the shift.
- Env noise ≠ failure (expected-refusal lists, intentional error-path tests).
- Known trap class: e2e fixtures comparing LOCAL calendar days break in the
  first hour after local midnight on UTC runners — "an hour ago" reads as
  yesterday, and any "today at <fixed future time>" seed sorts above real
  events in newest-first orders. Seed `max(now - N, local-midnight)` and
  share the constant with time-format assertions.
- Merge commits can break e2e semantically: after resolving conflicts, grep
  for identifiers whose definition lived on the other side (`ReferenceError`
  in a shard = lost definition), and re-check expectations written against
  the OTHER parent's semantics (status words, DOM contracts, removed
  features).

## 5. Merge window (after T1, all green)

Preconditions, in order:

1. Every in-scope PR: CI green, review without open blocker/major.
2. Blast radius empty: wait out working authors (branch tips quiet, turns
   completed), then stop lingering finished workloads gracefully via the
   seam. Re-check the blast query shows nothing before merging.
3. Merge in dependency order (producer repo first, e.g. a lib before its
   consumer; older PRs first). Plain merge commits unless the repo says
   otherwise.
4. Conflicts: resolve in a /tmp clone merging the target branch into the PR
   branch; prefer the side that made a deliberate product decision, keep
   both sides' feature blocks, run typecheck + unit suites + build locally,
   then push and let CI judge.

Concurrency: many CI setups cancel the in-progress run of the target branch
on a new push — merge sequentially if each deploy must be verified, or accept
the supersede and verify only the final SHA's run.

## 6. Deploy verification (blocking, until terminal)

If deploys are automatic, watch the run to its terminal state; if not,
trigger via the seam. Then, through the verification surface:

- The deployed revision equals the merged SHA.
- The deploy job reached a healthy terminal state; a failed or rolled-back
  deploy is investigated, fixed, retried — never leave main deployed-old
  silently.
- End-to-end smoke through the new revision (one real request path, whatever
  the service offers), then confirm the blast radius is back to empty.

## 7. Morning report

Verdict first (what is deployed, on which SHAs), then: merges, review
findings fixed vs deferred (minors/suggestions with IDs), failures
investigated and how each was classified, coordination with live authors
(steers, stopped workloads), leftovers (in-work branches, follow-ups).
No ceremony.

## Done is observable

- [ ] Zero open PRs in scope, or each remaining one has a reason (in work / blocked).
- [ ] Every repo's target branch deployed and verified: revision = merge SHA, terminal state healthy.
- [ ] Smoke passed; blast radius empty again.
- [ ] Report delivered with deferred findings list.

---

## Example profile: zavod homelab

One filled-in set of seams, kept as the reference answer sheet:

- **deploy trigger**: green push to `main` runs a CI `deploy` job that POSTs
  the SHA to the server; the server updates itself and restarts its systemd
  units (server + node). Base URL: repo variable `ZAVOD_DEPLOY_URL`.
- **blast radius**: `POST $DEPLOY/api/sessions/reconcile` → per-node
  runtimes; `capacity.live` is the count, `activity.at` the liveness stamp.
- **graceful stop**: `POST $DEPLOY/api/sessions/:id/stop` (record survives,
  resumable).
- **author channel**: `POST $DEPLOY/api/sessions/:id/command` with
  `{"command":"steer","params":{"message":"…"}}` — queues while the author's
  turn runs.
- **verification surface**: `GET /api/health` (revision), `GET
  /api/system/update` (terminal job state), `GET /api/nodes` (auto nodes
  report the new revision; manual-mode nodes legitimately lag). Smoke:
  create a throwaway session (also proves pre-session dependency updates,
  e.g. `agent-kit update`), `getState`, stop, delete.
