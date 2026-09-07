# Task Workspace architecture

How the dotfiles task-workspace framework runs on a **stock** OMP install: no
core patch, no fork, no runtime dependency on OMP source checkouts. The
framework is a local extension layer plus workflow instructions, delivered via
chezmoi.

## Two different delegation entities

**`workspace_agent` — repo-rooted top-level owner.** Spawns a full agent
session whose `cwd` and `SessionManager` are pinned to a managed task worktree
(`~/.omp/tasks/<workspace>/<repo>`). Properties:

- works with relative paths; writes land in the worktree, never in the source
  checkout;
- receives the target repository's own project instructions (`AGENTS.md`,
  `CLAUDE.md`, `GEMINI.md`, `SYSTEM.md` at the repo root) explicitly via
  `contextFiles`; orchestrator-side context is never passed;
- project-local extensions and skills of the target repository are discovered
  normally relative to it;
- may delegate repo-local helpers with the stock `task` tool — nested helpers
  inherit the same worktree because the whole session is rooted there;
- uses a private `AgentRegistry` and an in-memory `SessionManager` per
  invocation, so parallel owners never collide;
- must finish with a strict structured yield envelope:
  `{status: done|partial|blocked, summary, verification, gaps}`;
- loses exactly one tool: `workspace_agent` itself (no recursive workspace
  owners). Everything else, including `task` and the task-workspace runtime
  tools, stays active.

**`task` — normal nested subagent delegation.** The stock mechanism. Use it
inside an owner for helpers that work within the same repository. It is not a
workspace spawner and does not root sessions.

## Deterministic runtime tools

`task_status`, `ensure_task_repo`, `checkpoint_commit` (extension
`task-workspace.ts`) manage worktree lifecycle, branch/fetch semantics, commit
staging, hooks, and the primary-checkout mutation guard. Highlights:

- a local task branch is attached without network; an absent branch is
  materialized only after one successful fetch (fail closed on fetch failure)
  as an attached tracking branch, never detached HEAD;
- workspace identity is the workspace path; `task_status` reports a `key`
  (flattened branch, opaque) and per-repository branches;
- deferred-hook bypass evidence is bound to the exact staged tree of the failed
  attempt, and manual checks require machine-readable pass results;
- the guard classifies every `git` invocation in a compound command and blocks
  any mutating one aimed at a primary checkout, hinting the managed worktrees
  of the same repository only.

## Fallback and guarantees

`workspace_agent` returns `unsupported` with `dispatched=false` when a required
public SDK capability is missing, the workspace validation fails, or the child
session cannot initialize. Main may then degrade to the documented mode: stock
`task` owner whose prompt carries the absolute managed worktree path.

After `session.prompt(assignment)` has started there is **no** automatic
fallback — the child may already have mutated the repository. Failures past
that point return `partial` or `blocked` with `child_may_have_mutated_repo`,
and repair means a fresh `workspace_agent` invocation that first inspects
existing state (owners are ephemeral; the durable state is the repository).

Honest compatibility statement: if a future OMP removes a required public SDK
capability, the framework fails closed or degrades to the documented
absolute-path mode, provided the extension system itself stays compatible. No
guarantee is made against arbitrary breaking changes.

## Known limitations

- The workspace directory name is the flattened branch name and is not
  injective: distinct branch identities can flatten to the same directory. No
  manifest or migration exists; rename a workspace manually if a collision
  ever materializes.
- RepoOwner sessions are ephemeral (in-memory); conversation history is not
  persisted. Everything durable lives in git.
- Only root-level project instruction files are passed explicitly; deeper
  instruction-file discovery inside the workspace behaves like stock
  discovery for that session's own cwd.

## Verification

Deterministic harness (no model, no provider):
`bash tests/task-workspace/build-fixture.sh && bun run tests/task-workspace/verify-scenarios.ts`
then `verify-scenarios-2.ts` (guards, lanes, deferred hooks) and
`verify-bridge.ts` (real SDK + scripted mock model). Extensions typecheck
against the stock SDK surface via
`dot_omp/private_agent/extensions/tsconfig.json`. A model-backed smoke
(`tests/task-workspace/smoke-model-backed.ts`, opt-in via `TW_MODEL_SMOKE=1`)
runs one real rooted session against the installed OMP configuration.
