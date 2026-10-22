---
name: pr-babysitter
description: "Overnight/shift gatekeeping over PRs authored by a fleet of parallel agents: watch open PRs and CI to a deadline, review each PR with fresh subagents, repair red CI, merge in dependency order, and deploy a self-restarting service (zavod-style) without killing live agent sessions. Use when the user asks to 'watch the PRs', 'merge everything by morning', 'deploy while the agents run', or hands over repos whose agents are still working and the deploy would restart them."
---

# PR babysitter

The deploy restarts the service and kills everything running on it. Your job:
everything the user asked for is merged, deployed and verified by the deadline,
and nothing that was still alive gets murdered on the way.

## 0. Intake — establish before the first watch cycle

- Repos and scope (only these; other repos are out of scope unless asked).
- Deadlines: typically "CI green by T1, merged after, deployed and verified by T2".
- Deploy trigger: for zavod a green push to `main` runs a CI `deploy` job that
  POSTs the SHA to the server; the server updates itself and restarts its units.
  Deploy base URL: `gh variable list` → `ZAVOD_DEPLOY_URL` (repo variable).
- Live-session source: `POST $DEPLOY/api/sessions/reconcile` — per-node runtimes
  with `state`, `lastTurn`, `activity.at` (agent's last tool call).
- No-CI repos (e.g. agent-kit): merge has no gate; order only by dependencies.
- What NOT to touch: branches the user says are still in work; the user's
  primary checkouts and agent worktrees (work only in a fresh `/tmp` clone).

If the user goes to sleep: no questions, full autonomy. Genuinely unresolvable
without him → leave that piece untouched and report it.

## 1. Watch loop (until T1)

Every ~10 min, bounded sleeps:

- New PRs in scope (`gh pr list` per repo) → open a review per PR (§2).
- CI status per PR; red → triage (§4).
- Branch tips of open PRs: a tip that moved recently means the author agent is
  ALIVE — never push to that branch, coordinate instead (§3).
- `reconcile`: `activity.at` newer than a few minutes = a working agent. A
  `working` state with a stale `activity.at` may be a dead display — the branch
  tip on GitHub is the ground truth of author liveness.
- A runtime with a completed/failed lastTurn and hours-stale activity is
  stoppable via `POST /api/sessions/:id/stop` (graceful, record survives) —
  do that in the merge window, not during the watch.

## 2. Review each PR

Fresh subagent per PR (or one for a coupled producer/consumer pair — review
cross-repo contracts together, both directions). Prompt essentials:

- Isolated clone in `/tmp`, `git checkout --detach <exact head SHA>`, read FULL
  changed files (not just hunks), diff against `origin/main`.
- `skill://lazy-mr-review` supports both GitLab and GitHub natively; no
  publication to the PR at all — findings go to chat only.
- Evidence by execution: targeted test suites at the SHA; assert imports
  resolve inside the checkout; label static suspicions `static`, unproven
  `conditional`.
- Severity ladder: blocker / major (must fix before merge) / minor / suggestion.
- Model fallback: if the review subagent dies on a provider rate limit, respawn
  on another model class.

Never merge with an open blocker/major from a review you trust.

## 3. Repair etiquette on agent-owned branches

- Fetch the branch tip right before pushing; if it moved, rebase your commits
  onto the new tip. Never force-push.
- Prefer letting the LIVE author self-repair (they watch their own CI). Steer
  it through the service instead of racing it:
  `POST /api/sessions/:id/command {"command":"steer","params":{"message":"...factual diagnosis + your commit SHA + don't duplicate..."}}`.
  A steer queues while the agent's turn runs.
- Your commits: English, scoped, state the root cause in the message. Red-check
  regression tests (temporarily revert the fix, prove the test fails, restore).
- If the user says the PR is still in work — hands off entirely.

## 4. CI failure triage

Classify before acting; never blind-rerun:

- Deterministic → read the failing step's real error (the check name + the
  thrown line, not the summary), reproduce locally in the /tmp clone, fix.
- Flaky (passes locally / failed once on CI / known-noise lines) → one rerun
  with a stated reason; a second failure means treat as deterministic.
- Pre-existing on main → prove by running the same suite on a pristine
  `origin/main` checkout; then it is out of scope for the night.
- Env noise ≠ failure (expected-refusal lists, intentional ECONNREFUSED tests).
- Known traps: e2e fixtures comparing local-calendar days break in the
  00:00–01:00 window on UTC runners ("an hour ago" = yesterday; "local noon"
  = the future before noon, breaking newest-first ordering) — seed
  `max(now - N, local-midnight)` and share the constant with any HH:MM check.
- Merge commits can break e2e semantically: after resolving conflicts, grep for
  identifiers whose definition lived on the other side (`ReferenceError` in a
  shard = lost definition), and re-check status-word/DOM expectations written
  against the OTHER parent's semantics.

## 5. Merge window (after T1, all green)

Preconditions, in order:

1. Every in-scope PR: CI green, review without open blocker/major.
2. Live runtimes on deploying nodes = 0: wait out agents still working (branch
   tips quiet, lastTurn completed), then stop idle ones via
   `POST /api/sessions/:id/stop`. Verify `reconcile` shows `live: 0`.
3. Merge in dependency order (producer repo first, e.g. agent-kit before a
   zavod consumer; older PRs first). Plain merge commits (repo convention).
4. Conflicts: resolve in a /tmp clone merging `origin/main` into the PR branch;
   prefer main's deliberate product removals, keep both sides' feature blocks,
   run typecheck + full unit suites + build locally, then push and let CI judge.

Concurrency: a new push to `main` cancels the in-progress run of the workflow
(same concurrency group) — merge sequentially if you need each deploy verified,
or accept the supersede and verify only the final SHA's run.

## 6. Deploy verification (blocking, until terminal)

Watch the `main` run to `success`, then:

- `GET /api/health` → `revision` equals the merged SHA.
- `GET /api/system/update` → job for that SHA in terminal `healthy` (or the
  error — a failed/rolled-back deploy turns the CI run red; investigate, fix,
  retry — never leave main deployed-old silently).
- `GET /api/nodes`: auto-update nodes report the new revision; manual-mode
  nodes legitimately lag (note it in the report, don't force them).
- End-to-end smoke through the new revision: UI `GET /` serves, create a throwaway
  session (this also proves pre-session dependency updates, e.g. `agent-kit
  update`), `getState`, stop, delete. Nodes report `live: 0` again afterwards.

## 7. Morning report

Verdict first (what is deployed, on which SHAs), then: merges, review findings
fixed vs deferred (minors/suggestions with IDs), failures investigated and how
each was classified, coordination with live authors (steers, stopped sessions),
leftovers (in-work branches, manual nodes, follow-ups). No ceremony.

## Done is observable

- [ ] Zero open PRs in scope, or each remaining one has a reason (in work / blocked).
- [ ] `main` of each repo deployed: health revision = merge SHA, update job healthy.
- [ ] Smoke passed; nodes healthy; live runtimes back to 0.
- [ ] Report delivered with deferred findings list.
