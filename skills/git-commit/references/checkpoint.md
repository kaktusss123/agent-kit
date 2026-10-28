# Checkpoint commit runtime (Pi)

Deterministic contract of the `checkpoint_commit` tool (task-workspace Pi extension). The tool owns staging integrity, secret screening, hook execution, and primary-checkout protection; the model supplies judgment (paths, message, evidence) and reads structured results.

## The call

```
checkpoint_commit(repo, paths, message, allow_primary?, deferred_hook?)
```

- `repo` — repository path (root or any directory inside one); must be a git repository.
- `paths` — the exact intended file paths to stage and commit. This is the entire intended scope; the tool stages exactly these paths and, after hooks run, verifies the created commit against this set. For a merge commit, `paths` must list every path the merge brings from the first parent; the commit cannot be narrower than the merge.
- `message` — the full commit message per SKILL.md policy.
- `allow_primary` — set only for the explicit user-requested manual-source commit; anything else on a primary checkout is rejected.
- `deferred_hook` — evidence object; see below. Never a first attempt.

The tool always runs repository hooks on the commit attempt; there is no way to skip them through this interface, and raw `--no-verify` via bash is blocked separately.

## Results and the required reaction

- `committed` — done. The result carries commit id, branch, and files. Confirm the id and report.
- `primary_commit_blocked` — the target is the primary checkout without `allow_primary`. Route the work to the managed task worktree, or stop if the user's explicit manual-commit exception applies (then retry with `allow_primary: true`).
- `secret_path_rejected` — one of `paths` matches a secret-like pattern. Never "fix" by renaming or embedding; drop the path or get the user's explicit safe-fixture identification.
- `ambiguous_staged` — the pre-existing staged set differs from the intended paths, and merging would silently broaden scope. Resolve with the user (or explicitly include the pre-staged paths in `paths` when they are genuinely part of the checkpoint).
- `path_outside_repo` — a path outside the repository was passed; correct the path set.
- `commit_failed` — hook failure or git error. The result includes the failed hook's output and a `staged_tree` SHA binding the exact staged contents. Decide: code-validation failure → fix or escalate (never defer); external-prerequisite failure → see below.
- `commit_scope_mismatch` — the created commit file set differs from the intended path set, typically because a pre-commit hook staged extra files or dropped intended ones: hooks may adjust the index they run against, and Git commits that adjusted index (`git commit --only` does not prevent this). The commit exists; the tool refuses to report success. Inspect the commit and decide the repair (for example revert it) — nothing is rewritten automatically.
- `deferred_hook_rejected` — the evidence did not authorize the bypass (wrong tree SHA, non-passing manual check, non-external blocker kind, evidence fields missing). Re-verify reality; do not resubmit the same evidence.
- `committed_with_deferred_hook` — committed with the gap recorded; the result carries commit id, failed hook, failure reason, manual checks, and `remaining_gap`.

`error` results carry a message; treat them as tool failures, not commit outcomes.

## Deferred hook verification

For autonomous long-run tasks that hit a hook which physically cannot pass yet — typically a lockfile/compile step on a same-task dependency another repository has not published.

The normal hooked commit is always attempted first, inside the same call; deferral happens only when that attempt failed, the failing step appears in the actual hook output, and the staged contents are unchanged. Retry with `deferred_hook` only when all of these hold, providing evidence verbatim from the failed attempt:

- `blocker_kind`: `external_prerequisite` or `external_availability` — after a reasonable retry; never a negative verdict on the changed code. Test, lint, typecheck, format, secret-scan, and generated-code failures are never deferrable.
- `failed_hook`, `failed_step_command`, `failure_reason` — the established cause, not a guess.
- `staged_tree` — the SHA from the `commit_failed` result, proving the manually verified contents are the contents being committed.
- `manual_checks` — every hook check runnable without the blocker, executed by hand, each with `command` and a machine-readable pass result. Anything else (skipped, unknown, prose) does not authorize the bypass.
- `remaining_gap` — written down.

Downstream obligations on `committed_with_deferred_hook`: the repository is NOT fully verified; surface the gap in the task report and in any unpublished draft, and do not create the MR until the deferred check is re-run and passes. If the prerequisite becomes available later in the same run, rerun the deferred check — a pass closes the gap, a fail is a real verification failure requiring repair.

## Relationship to the workspace guard

Primary-checkout protection here is the commit-path half of the task-workspace mutation guard (`skills/git-task/references/task-workspace.md`): file and bash mutations outside the managed worktree are blocked earlier, so a `primary_commit_blocked` usually means the work itself was addressed at the wrong checkout.
