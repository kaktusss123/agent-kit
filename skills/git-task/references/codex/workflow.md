# Codex task workflow (CLI 0.166.0)

Read this binding before the Pi runtime references. Shared `git-task` policy
(identity, authorized base, single canonical workspace, ownership, review and
repair) still applies; Pi tool names below that skill are not native Codex APIs.

## Shared task core

Run `agent-kit task <op> '<json>'` through the shell; `-` reads JSON from stdin.
Use absolute paths. The CLI session cwd is the shell's actual cwd.

| Operation | Parameters |
| --- | --- |
| `status` | `{ "path": "<repo-or-worktree>" }` (optional path) |
| `ensure` | `{ "branch": "<task branch>", "source_path": "<repo>" }`; optional authorized `base_ref`, `remote`; secondary lanes additionally `task`, `slot` |
| `remove-lane` | `{ "task": "<identity>", "path": "<lane>" }` |
| `teardown` | `{ "task": "<identity>" }` |
| `commit` | See `skills/git-commit/references/codex/checkpoint.md` |
| `current` | `{ "cwd": "<absolute path>", "selections": [] }` (read-only projection) |

Exit 0 means a structured result, not necessarily success: inspect `status`.
Exit 1 is an error and exit 2 is usage failure. `base_selection_required` needs
a user decision, never a guessed base. The runtime never forces or resets.
`ensure` reports the actual managed worktree and task workspace; retain these
paths. Never create an ordinary worktree by hand as a substitute.

## Native delegation

Use the native agent tools exposed by this Codex session (`spawn_agent`,
`send_input`, `wait_agent`, `resume_agent`, `close_agent` in the v1 tool catalog
of CLI 0.166.0). The v2 catalog exposes `send_message` / `followup_task` for
messaging/continuation instead; use the actual tool schema in your session,
not invented aliases. Some catalogs namespace these tools.
If delegation is unavailable, report implementation as blocked; do not silently
implement in Main or the primary checkout. Do not assume Pi `subagent` ops,
model-role aliases, workspace parameters or runtime report tools exist.

Main owns discovery, user decisions, the canonical specification, review and
integration. For each writable repository dispatch exactly one repository owner
with `spawn_agent`. Its assignment must state the absolute managed worktree,
allowed repository, intent/SPEC path, base, constraints, required checks and
checkpoint/post-commit verification. Tell it to read local project rules,
`implementation`, `verification-design`, and the Codex checkpoint binding.
Independent repositories may run in parallel. A dependency's contract-fixing
checkpoint must precede a dependent owner's mutations.

Read-only researchers/reviewers are separate fresh agents explicitly forbidden
from mutation. Do not pass model configuration unless requested by the user.
Codex has no Pi ownership lease, readiness handshake, enforced deadline, terminal
report envelope or `git_facts`. One active owner per repository is a controller
policy: keep its thread ID; a wait timeout is not settlement or permission to
start another writer. Use `send_input` for clarifications/steering, `wait_agent`
to wait for the same run, and `resume_agent` only when continuing a closed thread.
In the v2 catalog use `send_message` for active-thread messages and
`followup_task` for subsequent work instead of assuming v1 continuation APIs.
Close finished agents with `close_agent` when exposed. Do not assume stopping a thread rolled
back any writes. Inspect state before a replacement owner starts.

Owners report `done`, `partial` or `blocked`, changed paths, commands/results,
remaining gaps and contract conflicts in their final message. `done` requires a
checkpoint followed by final verification of that exact committed candidate;
a later change requires a new checkpoint and verification. Ask the user only
for decisions Main cannot already resolve.

Before accepting an owner, Main reads settled facts itself:

```
agent-kit task status '{"path":"<absolute worktree>"}'
git -C <absolute-worktree> rev-parse HEAD
git -C <absolute-worktree> status --short
```

Verify the task branch, candidate commit, upstream and clean state. Unknown or
unavailable dirty facts are not evidence of cleanliness. Review the actual diff
against the dispatched base per `skill://code-review`. Make an explicit own-review
versus independent fresh-context review decision. Substantial changes normally
need an independent read-only reviewer; it must not be the implementing owner.
Repair uses a fresh owner that first inspects current state, never Main or the
reviewer editing the candidate. A missing notification is not permission to
redispatch blindly: inspect the original thread and worktree first.

## Guard and manual fallback

Installation supplies `${CODEX_HOME:-$HOME/.codex}/hooks.json`. Review/trust
non-managed hooks through `/hooks`; never change trust/bypass configuration on
the user's behalf. `PreToolUse` for `Bash` rewrites `tool_input.command` using
`permissionDecision: allow` plus `updatedInput.command`, exporting the existing
Git shim environment before the original command. It does not use SessionStart
or a Claude env file. The shim checks actual Git argv/cwd after `cd`, Git `-C`
and ordinary nested shells, including the global raw `--no-verify` prohibition.
Native `apply_patch` uses the same `tool_input.command` field; the adapter guards
every add/update/delete source and move destination against actual `input.cwd`.
Malformed input/adapter failures produce an explicit deny where the adapter runs.

This is routing protection, not a sandbox. Disabled/untrusted hooks, hook process
errors/timeouts (which Codex may fail open), absolute Git executable paths,
shells resetting PATH, arbitrary shell file writes and subsequent `write_stdin`
input are not a guaranteed enforcement boundary. Do not claim active protection
from the presence of files alone. Even without hooks, use absolute managed paths
for all writes, `git -C <managed-worktree>`, and `agent-kit task commit`; verify
primary-checkout status remains unchanged. A guard block is a routing failure,
never authority to retry the mutation through another tool or agent.

Protocol source: https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/hooks
