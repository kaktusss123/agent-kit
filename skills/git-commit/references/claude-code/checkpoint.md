# Checkpoint commit runtime (Claude Code)

Claude Code binding of `checkpoint_commit`: the same core code behind the Pi tool, called as

```
agent-kit task commit '{"repo": "<path>", "paths": ["…"], "message": "…"}'
```

with the optional `allow_primary` and `deferred_hook` keys exactly as in `references/checkpoint.md`. Inputs, every result status (`committed`, `primary_commit_blocked`, `secret_path_rejected`, `ambiguous_staged`, `path_outside_repo`, `commit_failed`, `commit_scope_mismatch`, `deferred_hook_rejected`, `committed_with_deferred_hook`), the required reactions, and the deferred-hook evidence rules are defined there and hold unchanged.

CLI specifics:

- Output is one JSON object; exit code 0 for any commit outcome above (including refusals), 1 for `status: "error"`, 2 for a usage error (nothing ran).
- For a long message or `deferred_hook` evidence, pass the JSON on stdin: `agent-kit task commit - <<'JSON' … JSON`.
- Repository hooks always run. Raw `git commit --no-verify` is blocked by the plugin's git guard only when it is active; in an unguarded session (see `skills/git-task/references/claude-code/task-workspace.md`) commit only through this CLI.
