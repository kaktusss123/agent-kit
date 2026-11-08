# Codex checkpoint binding

Use the host-neutral task CLI, not a Pi tool or raw Git commit:

```
agent-kit task commit '{"repo":"<absolute managed worktree>","paths":["src/file"],"message":"feat: describe the change"}'
```

For complex JSON, send it on stdin with `agent-kit task commit -`. Follow the
shared `git-commit` policy for ticket/branch/message judgment, explicit paths,
secrets, no push and no raw `--no-verify`. The CLI runs the same checkpoint core
as Pi and Claude Code; it strips the routing shim for its own controlled Git
operations. It does not require a Pi extension, plugin or Codex session state.
Repository hooks run normally. Exit 0 still requires inspecting result status;
exit 1 is a tool error, exit 2 a usage error. Never treat empty/invalid output as
a commit. `allow_primary` is reserved for an explicit user request to commit
their own manual primary-checkout changes, never task-generated changes.

## Result handling

- `committed`: retain the commit ID and run final verification AFTER this commit.
- `primary_commit_blocked`: route to the managed worktree; do not bypass.
- `secret_path_rejected`: remove the path or obtain explicit safe-fixture authority.
- `ambiguous_staged`: stop; do not silently combine unrelated staged paths.
- `path_outside_repo`: correct the intended exact path set.
- `commit_failed`: inspect actual hook/Git output and `staged_tree`. Fix code,
  test, lint, formatting, generated-content, secret-scan and unknown failures;
  these cannot authorize deferral. After two failed attempts, stop with evidence.
- `commit_scope_mismatch`: the commit exists but differs from the intended file
  set (for example a hook staged extra files). Inspect and repair explicitly;
  never declare the checkpoint successful.
- `deferred_hook_rejected`: evidence did not authorize the bypass; re-examine it.
- `committed_with_deferred_hook`: report the remaining gap; not fully verified.
- `error` or unrecognized status: blocked, not a checkpoint success.

## Deferred hook verification

Only after a real current hook failure caused by an external prerequisite or
availability blocker may the same CLI call be retried with `deferred_hook`.
Supply `blocker_kind` (`external_prerequisite` or `external_availability`), actual
`failed_hook`, `failed_step_command`, `failure_reason`, the exact `staged_tree`
SHA from the failure, `manual_checks` (objects with `command` and a machine-readable
passing `result`) and `remaining_gap`. A normal hooked commit is attempted first;
the evidence is bound to that exact staged tree. Missing tools reasonably
installable locally and ordinary code validation failures are not external gaps.
No bypass switch, raw `git commit --no-verify`, or ad-hoc staged-tree replacement
is permitted. Re-run a deferred check when its prerequisite becomes available;
surface any remaining gap to Main and in a change request before publication.

Codex hook trust/errors can leave a session unguarded. This does not weaken the
commit policy: still use this CLI, never raw hook bypass. After any commit, read
HEAD and working-tree state and verify the exact candidate before reporting done.
