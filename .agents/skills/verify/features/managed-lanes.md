# Managed same-repository lanes

Prerequisites: Git, Node.js, local Pi test dependencies. No remote service or credentials are needed.

Drive the actual managed-worktree flows and owner dispatch boundary:

```sh
node --test --test-timeout=180000 --test-name-pattern='managed same-repository lanes' extensions/subagents/workspace-runs.test.ts
node --test --test-timeout=180000 extensions/task-workspace/owner-lock.test.ts extensions/task-workspace/teardown-task-repo.test.ts
```

Expected: the first test creates one canonical worktree before its named lane from an exact common snapshot. Two branches and physical output destinations remain distinct while two owners run. A duplicate owner for either tree or a symlink alias is refused without spawning another child. Releasing one owner does not release the other. Dirty/owned lanes and whole owned tasks cannot be removed. Once released and clean, non-force lane removal and task teardown succeed, leaving the fixture source clean.

Evidence: test names, results and failing status payloads. Git worktrees and cross-process lease attempts are real; agent RPC child work is simulated. The owner-lock suite additionally uses real OS processes for exclusion and crash recovery. This is not a paid-model arena run.

Gotchas: use the short isolated HOME and non-Git TMPDIR from CONTRIBUTING.md. Do not work around a primary guard failure; fix the fixture's routing or report the blocker. Cleanup removes only the roots created by these tests, never task branches belonging to the user.
