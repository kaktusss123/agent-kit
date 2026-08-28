# Cracker/Implementer Workflow Architecture — v2

## Overview

Two-role development lifecycle for multi-repo tasks:
**cracker** (analyst) → spec in git → `/task_approve` (freeze hash) → **implementer** (clean session) → verified implementation

## Skills

**`cracker/SKILL.md`** — Analyst. Never modifies production code. Sole artifact: `docs/specs/<id>.md`. Code snippets/pseudo-code/API signatures allowed inside spec.

**`implementer/SKILL.md`** — Executor. Entry: reads spec, confirms design against real code. Escalation via BLOCKED format. Self-review. Report.

Both user-level, at `~/.omp/agent/skills/`.

## Task Runner Extension

**Path:** `~/.omp/agent/extensions/task-runner.ts`

### State machine

```
analysis → approved → implementing → completed
```

Manifest field `phase`. Transitions enforced by commands.

### Manifest schema

```json
{
  "id": "EVODP-12345_trino_private_versions",
  "type": "feat",
  "phase": "analysis",
  "primary": "trino-instance",
  "repos": {
    "trino-instance": {
      "path": "/Users/.../trino-instance",
      "role": "primary",
      "worktreeCreated": false,
      "branch": null,
      "worktreePath": null
    },
    "trino-lib": {
      "path": "/Users/.../trino-lib",
      "role": "target",
      "worktreeCreated": false,
      "branch": null,
      "worktreePath": null
    },
    "upstream-trino": {
      "path": "/Users/.../upstream-trino",
      "role": "reference",
      "worktreeCreated": false,
      "branch": null,
      "worktreePath": null
    }
  },
  "specPath": "docs/specs/EVODP-12345_trino_private_versions.md",
  "approvedSpecHash": null,
  "snapshotHash": null,
  "createdAt": "ISO"
}
```

### Commands

**`/task_init <id> [type]`**
- Creates manifest with `phase: "analysis"`
- Primary = current cwd, role `primary`
- Sends agent `skill://cracker` + "describe the task"

**`/task_add_repo <id> <path> [target|reference]`**
- Only during `analysis` phase
- Role: `target` (default) — gets worktree at handoff. `reference` — read-only, no worktree.
- Validates: git repo exists. No duplicate names.
- Name = path basename

**`/task_approve <id>`**
- Reads current spec from primary repo
- Computes SHA256 → `approvedSpecHash`
- Sets `phase: "approved"`
- Approval bound to exact spec version — any later spec change blocks handoff

**`/task_handoff <id>`**
- Phase must be `approved`
- Validates: spec SHA256 matches `approvedSpecHash` (no drift)
- Checks repo cleanliness: only spec file allowed dirty; all other changes block
- Creates git worktrees: `git worktree add -b <type>/<id> <task-dir>/<name> HEAD`
  - Only for `primary` and `target` repos (not `reference`)
  - Already-created worktrees (per-repo `worktreeCreated: true`) are skipped
- Snapshots spec → `snapshot.spec.md` with SHA256 in `manifest.snapshotHash`
- Copies approved spec into primary worktree: `<primary-worktree>/docs/specs/<id>.md`
- Sets `phase: "implementing"`
- Calls `ctx.newSession({ setup })`:
  - `sm.moveTo(worktreePrimary)`
  - `sm.addWorkspaceDirectory()` for each target worktree (not `reference` repos, not `taskDir`)
  - `sm.appendMessage()` with `skill://implementer` + spec path + repo map

### Per-repo idempotency

Each `RepoEntry` tracks `worktreeCreated: true|false`, `branch`, `worktreePath`. Preflight validates all repos before creating any worktree. If creation succeeds, per-repo state is saved to manifest. Resume: completed repos are skipped.

### File layout

```
~/.omp/agent/skills/
  cracker/SKILL.md
  implementer/SKILL.md

~/.omp/agent/extensions/
  task-runner.ts

docs/specs/<id>.md                 ← primary spec (git-trackable, in primary repo)

~/.omp/tasks/<id>/
  manifest.json
  snapshot.spec.md                   ← frozen copy, SHA256 in manifest
  <repo-name>/                      ← git worktree, <type>/<id> branch
```

### Security

- `validId`: `[A-Za-z0-9][A-Za-z0-9_-]+`, min 2 chars. Prevents path traversal.
- `node:fs/promises` mkdir, `Bun.write`/`Bun.file` — no shell interpolation.
- Per-repo `git rev-parse --show-toplevel` validates repo paths.

## Deferred: BB2 Enforcement

Separate extension. Not yet implemented.

- `omp_commit` — `<type>(<ticket>): <desc>` enforced format
- `omp_push` — feature branch only
- Snapshot write-protection via `tool_call` interception
- No bash filter (rejected due to poor model behavior)

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Approval via SHA + `/task_approve`, not manual `Status: approved` | Prevents spec mutation between approval and handoff |
| Phase machine in manifest | Idempotent commands, resumable handoff |
| `target` / `reference` repo roles | Reference repos do not receive worktrees or branches |
| Spec copy to primary worktree | Feature branch contains approved spec for git review |
| TaskDir NOT in workspace | Orchestration state stays separate from agent workspace |
| Handoff via `ctx.newSession()` + `moveTo()` | Clean session boundary, same OMP process |
| `task` subagents are context-isolated | Known: task tool docs say subagents start blank. Our choice: full interactive implementer session, not child agent |
| Spec in `docs/specs/` | git-trackable, reviewable via PR |
| Task-oriented worktree root `~/.omp/tasks/<id>/` | Task as organizing principle, not repo |
| Branch naming: `<type>/<id>` | e.g., `feat/EVODP-12345_trino_private_versions` |
| Cracker code snippets allowed | API signatures/pseudo-code in spec clarify contracts |

## Verification Status

| Capability | Status |
|---|---|
| `cracker` skill loading | ✅ Verified |
| `implementer` skill loading | ✅ Verified |
| Extension load + `/task_init` | ✅ Verified (smoke test) |
| `/task_add_repo` manifest mutation | ⚠️ Not runtime tested |
| `/task_approve` SHA + phase | ❌ Not tested |
| `/task_handoff` worktree creation | ❌ Not tested |
| `newSession` + `moveTo` + `addWorkspaceDirectory` | ⚠️ API names from d.ts, not runtime tested |
| `sendUserMessage` with `skill://cracker` | ⚠️ Not runtime tested (skill loading path may differ from TUI input) |
| BB2 enforcement extension | ❌ Not started |
