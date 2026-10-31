# task-workspace

Deterministic task-workspace runtime for pi: manages git worktrees for
multi-repo task isolation. Branch = task identity; the workspace root is
resolved by `task-root.ts`: the `AGENT_TASK_ROOT` override first, then the
default `~/.agent-kit/tasks`. The same task identity resolves to the same
filesystem location for every session. All state lives in git (branches +
worktrees); no manifest files.

## Session-scoped current task (inspection contract)

The inherited inspection channel exposes `data.task.current` for the current inspected session only; `task_current` reads this projection without scanning the host-wide catalog, while legacy `task` and `all` retain their existing catalog fields and add `current`.

Schema: `{ state: "none" | "ok" | "missing", identity: string | null, workspace: string | null, source: "cwd" | "session" | null, repos: Repo[] }`. `identity` is the task identity — the Git branch of the canonical call, e.g. `feat/work` — and `workspace` is its absolute directory, whose name is the identity's reversible encoding (`feat%2Fwork`), so distinct identities never share a directory. Each repo has `{ name, path, kind: "canonical" | "lane", slot, classification, branch, detached, headSha, upstream, dirty: { staged, unstaged, available }, gitAvailable, owners: [{ id, label, state }] }`. Failed Git reads have `gitAvailable: false` and/or `dirty.available: false`; empty dirty arrays are not proof of clean state. Missing/none always has `repos: []`. Owner references are active RepoOwner runs from this session matched to the exact repository worktree.

Selection uses a managed session cwd first, otherwise the most recent successful `ensure_task_repo` custom history entry on the current session branch. Entries are appended with `pi.appendEntry`, so branch switching and forks are isolated and compaction preserves the session history. For resumed histories predating custom entries, task-workspace narrowly recognizes successful `ensure_task_repo` tool results on that branch. No association means `none`; no host-catalog or branch-name fallback is performed.

`task_current` is a version-1 inherited read-only snapshot area: `{v:1, area:"task_current", data:{task:{current}}}`. Its projection is session-scoped; while no session is bound (including after shutdown), cwd-derived snapshots are disabled. Selected workspace read failures return `snapshot_failed` rather than being mislabeled `missing`; `ENOENT` remains a truthful missing workspace. `task` and `all` retain their legacy catalog fields and add `data.task.current`.

## Surfaces

- **`task_status`** — classify the current path and report current Git facts;
  list each managed task workspace with canonical-or-lane kind, slot, path,
  branch, HEAD, upstream, classification, dirty paths, and artifacts.
- **`ensure_task_repo`** — attach a source repo to the task workspace as a git
  worktree. Reuses existing worktrees, attaches existing local branches before
  considering remotes, or fetches and creates from remote branches/defaults. A
  local-only repository can create a task branch from an explicit local
  `base_ref`; without one it returns `base_selection_required`. When remote
  resolution is needed, explicit remote names must match a configured remote;
  existing local branches ignore the remote because it is irrelevant. Protected
  default development branches (`main`, `master`, `develop`) are refused as task
  branches. Never forces, resets, or detaches.
- **`remove_task_lane`** — safely remove one clean secondary lane from its
  managed task workspace (canonical worktrees rejected; non-force only).
- **`checkpoint_commit`** — stage exact paths and commit within a repository.
  Blocks primary-checkout commits unless `allow_primary=true`, rejects
  secret-like paths, verifies paths inside the repo, enforces exact staging,
  requires hooks to run, and verifies the created commit against the intended
  paths after hooks run (a hook-staged extra file fails closed as
  `commit_scope_mismatch`); `deferred_hook` allows controlled commit with
  deferred hook verification after a real external-prerequisite hook failure.
- **Mutation guard** — write/edit targets are classified by the `tool_call`
  interceptor; bash git mutations are enforced where git executes: the bash
  tool is overridden so each child gets a PATH shim (`shim/git`) that asks
  the policy module (`shim/policy.mjs`) per real git invocation — local
  mutations in managed and other linked worktrees pass, while mutations on
  the primary checkout of a repo with managed worktrees are blocked (routing
  failure), `--no-verify` everywhere, redirection via
  `--git-dir`/`GIT_DIR` fails closed; read-only and `push` pass.

## Layout

`cli.ts` is the second binding — `agent-kit task <op>` for Claude Code:
the same flows with JSON params/output, plus the Claude Code hooks
(`hook session-start` arms the git shim through `CLAUDE_ENV_FILE`,
`hook pre-tool-use` returns the write guard verdict); it never imports the pi
SDK. `bootstrap-config.ts` is the provisioning package list both bindings
share. `index.ts` is the pi binding (ExtensionAPI tool registration, TypeBox
schemas, result `details`, host bootstrap configuration, and the bash tool
override that arms the git PATH shim); `task-root.ts` is the task-root
resolution policy
(`AGENT_TASK_ROOT` override → `~/.agent-kit/tasks` default); the remaining
sibling modules (`flows.ts`, `git.ts`, `guard.ts`, `shim-path.ts`, `types.ts`)
are a host-independent core that receives its task root explicitly and returns
plain domain results. `core-isolation.test.ts` proves the core imports and
runs with no host context. `bootstrap.ts` is the host-independent
dependency-provisioning core behind the ensure flow's bootstrap step.

`shim/` holds the git guard: `shim/git` (a dumb POSIX PATH shim),
`shim/policy.mjs` (the routing policy, plain ESM on Node.js), and
`shim/classify.mjs` (the shared subcommand/flag classification tables,
re-exported by `guard.ts` — the single copy in the repository). The shim is
committed executable; installs are symlinks, so the exec bit carries over.

This directory is loaded as an additional extension entry by other consumers
(e.g. child agent profiles); it must stay self-contained here — no imports
from sibling extension directories.
