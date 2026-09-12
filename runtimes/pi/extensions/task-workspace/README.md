# task-workspace

Deterministic task-workspace runtime for pi: manages git worktrees for
multi-repo task isolation. Branch = task identity; workspace root =
`~/.omp/tasks/<branch_flat>/` (override with `OMP_TASK_ROOT`). All state lives
in git (branches + worktrees); no manifest files.

## Surfaces

- **`task_status`** — classify the current path and report current Git facts;
  list each managed task workspace with canonical-or-lane kind, slot, path,
  branch, HEAD, upstream, classification, dirty paths, and artifacts.
- **`ensure_task_repo`** — attach a source repo to the task workspace as a git
  worktree. Reuses existing worktrees, creates new ones from local/remote
  branches, or fetches and creates from the remote default. Never forces,
  resets, or detaches.
- **`remove_task_lane`** — safely remove one clean secondary lane from its
  managed task workspace (canonical worktrees rejected; non-force only).
- **`checkpoint_commit`** — stage exact paths and commit within a repository.
  Blocks primary-checkout commits unless `allow_primary=true`, rejects
  secret-like paths, verifies paths inside the repo, enforces exact staging,
  requires hooks to run; `deferred_hook` allows controlled commit with
  deferred hook verification after a real external-prerequisite hook failure.
- **Mutation guard** — `tool_call` interceptor classifying every git invocation
  in bash commands (fail closed) and blocking `write`/`edit`/bash mutations
  outside the managed task worktree.

## Layout

`index.ts` is the host binding (ExtensionAPI tool registration, TypeBox
schemas, task-root policy, result `details`); the sibling modules (`flows.ts`,
`git.ts`, `guard.ts`, `types.ts`) are a host-independent core that receives its
task root explicitly and returns plain domain results. `core-isolation.test.ts`
proves the core imports and runs with no host context.

This directory is also loaded as an additional extension entry into
`workspace_agent` RepoOwner children (see `extensions/subagents/`), which is
why it must stay self-contained here.
