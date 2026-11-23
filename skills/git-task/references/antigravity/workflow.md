# Antigravity task workflow

Read this binding before the Pi runtime references. Shared `git-task` policy
(identity, authorized base, single canonical workspace, ownership, review, and
repair) still applies; Pi tool names in `SKILL.md` map onto Antigravity tools
and the host-neutral `agent-kit task` CLI as defined below.

## Shared task core

Run `agent-kit task <op> '<json>'` via `run_command`; `-` reads JSON from
stdin. Pass absolute paths. Each `run_command` starts a fresh shell session.

| Operation | Parameters |
| --- | --- |
| `status` | `{ "path": "<repo-or-worktree>" }` (optional path) |
| `ensure` | `{ "branch": "<task branch>", "source_path": "<repo>" }`; optional authorized `base_ref`, `remote`; secondary lanes additionally `task`, `slot` |
| `remove-lane` | `{ "task": "<identity>", "path": "<lane>" }` |
| `teardown` | `{ "task": "<identity>" }` |
| `commit` | See `$HOME/.gemini/config/skills/git-commit/references/antigravity/checkpoint.md` |
| `current` | `{ "cwd": "<absolute path>", "selections": [] }` (read-only projection) |

Exit 0 means a structured result, including refusals such as
`base_selection_required`, `remote_selection_required`, or `branch_in_use`:
inspect `status`. Exit 1 is a tool error (`status: "error"`); exit 2 is a usage
error. `ensure` returns the managed worktree and task workspace paths — retain
them verbatim and never substitute a hand-created worktree.

### Sandbox note

Antigravity runs `run_command` in Standard Sandbox Mode by default, which only
allows read/write access inside the active workspace and `/tmp`. Because
`~/.agent-kit/tasks` lives outside the workspace, `agent-kit task` commands
will usually fail with `Operation not permitted` / `EPERM` inside the sandbox.
Retry only that single `agent-kit task` command with `BypassSandbox: true`;
never chain unrelated steps into an unsandboxed command.

## Native delegation

Antigravity provides `define_subagent`, `invoke_subagent`, `send_message`, and
`manage_subagents`. Subagents run asynchronously and wake Main when they
finish or reply — do not poll in a loop.

### Defining and dispatching RepoOwners

Main owns discovery, user decisions, the canonical specification, review, and
integration. Repository mutation goes through RepoOwner subagents — Main never
edits task repositories itself.

Before dispatching the first owner in a session, define the `repo-owner`
subagent type once with `define_subagent`:

- `Name`: `"repo-owner"`
- `Description`: `"RepoOwner for one managed task worktree returned by agent-kit task ensure."`
- `EnableWriteTools`: `true`
- `SystemPrompt`:
  - Your absolute managed worktree path from the assignment is your only home.
    Use absolute paths for every file read/write/edit, and run every shell
    command with `cd <worktree> && ...` or `git -C <worktree> ...`.
  - Before making changes, read the applicable `AGENTS.md` / `GEMINI.md` and
    relevant project instructions inside that worktree (missing files are
    normal).
  - Change only this repository. Never touch the primary checkout or other
    repositories.
  - Commit only through `agent-kit task commit` (contract:
    `$HOME/.gemini/config/skills/git-commit/references/antigravity/checkpoint.md`).
    Never run raw `git commit`, never use `--no-verify`.
  - A guard denial is a routing failure, never permission to repeat the
    mutation through another tool or shell command.
  - You cannot ask the user directly. On a decision you cannot resolve, stop
    and return a `blocked` report naming the question.
  - Return the worker report contract (`done`, `partial`, or `blocked`, changed
    paths, commands/results, remaining gaps, contract conflicts). Report `done`
    only from a committed candidate verified AFTER that commit.

Dispatch each owner with `invoke_subagent`:

- `TypeName`: `"repo-owner"`
- `Workspace`: `"inherit"` (NEVER `"branch"` or `"share"` — `agent-kit task
  ensure` already owns the physical managed worktree)
- `Model`: `"inherit"` (unless the user explicitly requested another model)
- `Role`: e.g. `"RepoOwner (<repo>)"`
- `Prompt`: absolute managed worktree path, allowed repository, intent and
  `SPEC.md` path when present, dispatched base SHA, constraints, required
  skills (`implementation`, `tdd`, `verification-design`) and checks, and the
  checkpoint + post-commit verification contract.

Enforce at most one live owner per physical worktree (including path aliases).
Independent repositories — or deliberate named arena/swarm lanes with distinct
managed worktrees, branches, and outputs — may run in parallel. Dependent
owners wait for the upstream contract-fixing checkpoint.

### Questions, continuation, and read-only subagents

- Read-only researchers (during `/spec`) and independent fresh-context
  reviewers (during `/dev`) use `invoke_subagent` with `TypeName: "research"`,
  bounded to the absolute managed worktree path in the prompt. Never let an
  implementing owner review its own candidate.
- If an owner stops with a `blocked` question, resolve it in Main or ask the
  user, then continue the SAME owner via `send_message` using its
  `conversationId`. Do not spawn a fresh owner for an open question.
- Repair of a settled candidate uses a fresh `repo-owner` that first inspects
  the current worktree state — never Main or the reviewer patching the
  candidate.

## Settled-state verification (replaces `git_facts`)

Antigravity has no Pi `git_facts` envelope. After an owner finishes, Main reads
objective Git facts itself before accepting `done`:

```sh
agent-kit task status '{"path":"<absolute-worktree>"}'
git -C <absolute-worktree> rev-parse HEAD
git -C <absolute-worktree> status --short
```

Verify that `HEAD` moved to a new commit on the task branch, the worktree is
clean (no untracked non-ignored files), and the primary checkout has no new
task changes. Review the diff against the dispatched base per
`skill://code-review` and make an explicit own-review versus independent
fresh-context reviewer decision.

## Guard and manual discipline

The `agent-kit` plugin installs a `PreToolUse` hook
(`~/.gemini/config/plugins/agent-kit/hooks.json` → `antigravity/hook.ts`):

- Blocks `write_file`, `edit_file`, `write_to_file`, `replace_file_content`,
  and `multi_replace_file_content` when targeting tracked files of a primary
  checkout that has managed worktrees, or `.git` metadata.
- Blocks `run_command` invocations containing raw `git ... --no-verify`.
- Exits 0 with empty stdout on allowed calls so Antigravity's native
  permissions and sandbox stay intact.

This is routing protection, not a security sandbox. Shell file redirections and
mutating `git` commands inside `run_command` are not intercepted by a PATH shim
so sandboxed commands outside the `agent-kit` repository do not break. Always
route writes to absolute managed worktree paths, run `git -C
<managed-worktree>`, commit through `agent-kit task commit`, and check primary
checkout cleanliness before finishing.
