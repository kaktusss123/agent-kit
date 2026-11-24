# Antigravity checkpoint binding

Use the host-neutral task CLI via `run_command`, not a Pi tool or raw `git commit`:

```sh
agent-kit task commit '{"repo":"<absolute managed worktree>","paths":["src/file"],"message":"feat: describe the change"}'
```

For a long message or `deferred_hook` evidence, pass JSON on stdin:

```sh
agent-kit task commit - <<'JSON'
{
  "repo": "<absolute managed worktree>",
  "paths": ["src/file"],
  "message": "feat: describe the change"
}
JSON
```

If the sandbox blocks the task registry (`~/.agent-kit/tasks`), launcher, or
writable Git metadata, retry only that single `agent-kit task commit` command
with `BypassSandbox: true` (native per-command approval).

Follow the shared `git-commit` policy (`skills/git-commit/SKILL.md` and
`skills/git-commit/references/checkpoint.md`) for ticket/branch/message
judgment, exact intended paths, secret rejection, no implicit push, and no raw
`--no-verify`. The CLI runs the exact same checkpoint core as Pi, Claude Code,
and Codex; repository hooks always run.

Exit 0 still requires inspecting the returned JSON `status`; exit 1 is a tool
error, exit 2 is a usage error. Never treat empty or invalid output as a
commit. `allow_primary` is reserved for an explicit user request to commit
their own manual primary-checkout changes, never task-generated changes.

## Result handling

- `committed`: retain the commit SHA and run final verification AFTER this commit.
- `primary_commit_blocked`: route to the managed worktree; do not bypass.
- `secret_path_rejected`: remove the path or obtain explicit safe-fixture authority.
- `ambiguous_staged`: stop; do not silently combine unrelated staged paths.
- `path_outside_repo`: correct the intended exact path set.
- `commit_failed`: inspect actual hook/Git output and `staged_tree`. Fix code,
  test, lint, formatting, generated-content, secret-scan, and unknown failures;
  these cannot authorize deferral. After two failed attempts, stop with evidence.
- `commit_scope_mismatch`: the commit exists but differs from the intended file
  set. Inspect and repair explicitly; never declare the checkpoint successful.
- `deferred_hook_rejected`: evidence did not authorize the bypass; re-examine it.
- `committed_with_deferred_hook`: report the remaining gap; not fully verified.
- `error` or unrecognized status: blocked, not a checkpoint success.

## Deferred hook verification

Only after a real current hook failure caused by an external prerequisite or
availability blocker (`external_prerequisite` or `external_availability`) may
the same CLI call be retried with `deferred_hook` bound to the exact
`staged_tree` SHA from the failure, plus `failed_hook`, `failed_step_command`,
`failure_reason`, `manual_checks`, and `remaining_gap`. Never use raw
`git commit --no-verify`. After any commit, read `HEAD` and working-tree state
and verify the exact candidate before reporting `done`.
