# task-workspace

Deterministic task-workspace runtime for pi: manages git worktrees for
multi-repo task isolation. Branch = task identity; the workspace root is
resolved by `task-root.ts`: the `AGENT_TASK_ROOT` override first, then the
default `~/.agent-kit/tasks`. The same task identity resolves to the same
filesystem location for every session. All state lives in git (branches +
worktrees); no manifest files.

## Surfaces

- **`task_status`** — classify the current path and report current Git facts;
  list each managed task workspace with canonical-or-lane kind, slot, path,
  branch, HEAD, upstream, classification, dirty paths, and artifacts.
- **`ensure_task_repo`** — attach a source repo to the task workspace as a git
  worktree. Reuses existing worktrees, creates new ones from local/remote
  branches, or fetches and creates from the remote default. Protected default
  development branches (`main`, `master`, `develop`) are refused as task
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

`index.ts` is the pi binding (ExtensionAPI tool registration, TypeBox
schemas, result `details`, and the bash tool override that arms the git
PATH shim); `task-root.ts` is the task-root resolution policy
(`AGENT_TASK_ROOT` override → `~/.agent-kit/tasks` default); the remaining
sibling modules (`flows.ts`, `git.ts`, `guard.ts`, `shim-path.ts`, `types.ts`)
are a host-independent core that receives its task root explicitly and returns
plain domain results. `core-isolation.test.ts` proves the core imports and
runs with no host context.

`shim/` holds the git guard: `shim/git` (a dumb POSIX PATH shim),
`shim/policy.mjs` (the routing policy, runnable under node or bun), and
`shim/classify.mjs` (the shared subcommand/flag classification tables,
re-exported by `guard.ts` — the single copy in the repository). The shim is
committed executable; installs are symlinks, so the exec bit carries over.

This directory is loaded as an additional extension entry by other consumers
(e.g. child agent profiles); it must stay self-contained here — no imports
from sibling extension directories.
