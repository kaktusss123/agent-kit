# inspection-provider

Optional read-only ZIP v1 provider for Agent Kit. It adapts the Agent Kit Core
inspection state (subagents, task-workspace) into versioned capabilities and
registers itself in the provider registry that a controller-owned Pi bridge
publishes at `globalThis[Symbol.for("zavod.inspection.v1")]`.

Ownership boundary: the inspection wire, the descriptor transport, the
provider registry, `hello`/`snapshot` framing, `generation`, and `asOf`
belong to the controller (ZAVOD). This extension owns only the translation of
Core data into this document's capability contracts. It does not serve a
socket, read environment descriptor variables, or know any wire framing.

This extension registers **no** model tool, **no** slash command, **no**
prompt section, and **no** status line. An inspection-only extension cannot
add an LLM token or change the model's instruction set. It also never calls a
model, and its own code never spawns a process, starts a daemon, or runs the
`agent-kit` CLI: it lives inside the Pi process and reads Core state. The
`taskWorkspace.current` projection is Core's (`extensions/task-workspace`), so
the Git reads behind it are Core's own `git` calls, with Core's behavior and
limits; the provider adds no subprocess of its own on top of them.

## Inertness

The provider is a silent no-op when the bridge registry is absent, has a
different `version`, or does not expose `register`/`unregister`/`providers`:
no registration, no output, no error, nothing created on `globalThis`. That is
the normal case for a terminal Pi session without a node, and for a node whose
bridge is not loaded. A registry that throws is treated the same way: a broken
inspection channel must never break the Pi session.

Nothing here enables, disables, or reconfigures other extensions. Every
`/reload`, session switch, and resume re-evaluates this factory.

The Core seam module (`extensions/subagents/inspection-seam.ts`) is imported
dynamically, and only once a compatible registry is found: that module
publishes a process-wide registry at import time, and a bridge-less session
must not get Core state created on its behalf. Loading this extension without
a bridge therefore touches no `globalThis` slot at all.

## Registration lifecycle

```js
globalThis[Symbol.for("zavod.inspection.v1")] = {
  version: 1,
  register(provider),    // → owner token | null
  unregister(token),     // true only for the registration the token owns
  providers(),           // wire descriptors of the bridge's current generation
}
```

- Registration happens when the factory runs with a bridge registry already
  published, and again on every `session_start`.
- The bridge advances its provider generation whenever its own factory is
  re-executed and drops entries made in the previous generation. Because the
  bridge is appended to the Pi command line after the other extensions, its
  factory runs later, and `session_start` (fired after ALL factories ran) is
  the authoritative re-registration point. The provider is therefore present
  in `hello` from the first `session_start` of a process onward.
- Registration is idempotent per provider `id`: a re-executed provider
  replaces its own entry, and an owner token from the previous graph cannot
  remove the newer entry.
- `session_shutdown` does **not** unregister. The registration belongs to the
  generation, not to a session: after a shutdown the next `session_start`
  (a new, resumed, forked, or reloaded session) re-registers in the current
  generation, while an unregister from a dying graph could only remove its own
  record and would race the new one.

Provider shape registered here:

```js
{
  id: "agent-kit-inspection",
  adapterVersion,              // diagnostics, see "Identity"
  buildRevision,               // revision string or null, diagnostics
  capabilities: [{ name, version }],
  snapshot(feature, featureVersion, generation), // → data object | throw
}
```

The provider returns only the capability `data` body; `generation`, `asOf`,
and the `snapshot` envelope are the bridge's.

## Identity

`adapterVersion` and `buildRevision` are diagnostics: a consumer decides what
is supported from the exact capability versions, never from a version
comparison or a package name. Both values are read from files that describe
the code actually loaded (`./identity.ts`), walking up from the extension
directory at most four levels. The walk starts from the **real path** of the
extension directory (`fs.realpathSync`), because a normal Pi install loads it
through per-extension symlinks (`<agent-dir>/extensions/<name>` pointing into a
checkout or a pinned release); the link path itself is walked afterwards as a
fallback. Order:

1. `package.json` with a string `version` → `adapterVersion` is
   `agent-kit@<version>`;
2. `.git` (a directory or a worktree pointer file) → `buildRevision` is the
   `HEAD` revision, read from the Git files directly (a linked worktree is
   resolved through `commondir`; no `git` subprocess runs on the Pi startup
   path);
3. `manifest.json` with a string `sha` → `buildRevision` is the pinned
   revision of an `agent-kit snapshot` release (snapshot trees have no
   `.git`).

Otherwise `adapterVersion` is `agent-kit@unknown` and `buildRevision` is
`null`. When only a revision is known, `adapterVersion` is
`agent-kit@<first 12 revision characters>`.

## Capabilities

A capability is announced **only when its source is really loaded in this
process**. An extension that is not installed, not enabled for the session, or not
loaded by an isolated `--no-extensions` launch means the capability is absent —
not an empty answer.

| Capability | Version | Announced when | Source |
| --- | --- | --- | --- |
| `children.snapshot` | 1 | Core subagents are loaded | `extensions/subagents/inspection-seam.ts` |
| `children.historyRef` | 1 | Core subagents are loaded | the same seam |
| `usage.children` | 1 | Core subagents are loaded | the same seam |
| `background.status` | 1 | Core subagents are loaded | the same seam |
| `taskWorkspace.current` | 1 | task-workspace is loaded | `extensions/task-workspace/current.ts` |

Core is read only through the versioned read-only seam: the seam registry
carries `abiVersion: 1`, and a seam with any other ABI version is treated as
"Core not observable" — the `children.*`/`background.status` capabilities are
then not announced, and their snapshots fail as `provider_not_ready`. The
task-workspace extension publishes a presence marker
(`extensions/task-workspace/inspection-surface.ts`) at registration; the
provider never infers the projection's availability from tool names, file
presence, or package identity.

A provider with no available source is still registered, with
`capabilities: []`. That is how a controller distinguishes "inspector loaded,
Core absent" from "no inspector in this process" without trusting a package
listing.

Version comparison is exact: `featureVersion !== 1` is refused as
`incompatible_version`; a feature name this provider does not implement is
refused as `unsupported_feature`. Errors raised by a source propagate and are
reported by the bridge as `snapshot_failed`; a source that is no longer loaded
fails as `provider_not_ready`.

### `children.snapshot` v1

```json
{
  "agents": [
    {
      "id": "8f1c…",
      "label": "explore-docs",
      "state": "running",
      "startedAt": 1767225600000,
      "finishedAt": null,
      "sessionId": "01JD…",
      "model": "anthropic/claude-sonnet",
      "alive": true,
      "summary": "inspect the repository"
    }
  ]
}
```

- `id`, `label`, `state` — strings; `state` is the Core lifecycle state
  (`starting`, `running`, `waiting_input`, `completed`, `failed`,
  `cancelled`, …) and is passed through as reported. A record without an `id`
  is dropped; `label` falls back to `id`; an absent `state` becomes
  `unknown`.
- `startedAt`, `finishedAt` — epoch **milliseconds**, `null` when unknown;
  `finishedAt` stays `null` while the child has not finished.
- `sessionId` — string or `null`.
- `model` — string or `null`.
- `alive` — boolean; `true` only when the child process is still running.
- `summary` — the child's task prompt, clipped to 200 characters plus `…`
  when longer; `""` when Core has no task text.

Deliberately not included: child `cwd`, `pid`, `thinking`, environment,
activity log, active tool, pending question, exit code/signal, raw tool
arguments. None of those are needed to render or correlate a child, and
several would leak local process detail.

No filesystem path is part of this payload either — not even a verified one.
A child is identified by `id`/`sessionId` only; the transcript binding lives
in `children.historyRef` and nowhere else, so a consumer cannot reach an
unverified path through the snapshot.

### `children.historyRef` v1

```json
{ "agents": [{ "id": "8f1c…", "sessionFile": "/home/user/.pi/agent/sessions/….jsonl" }] }
```

Only bindings that were verified to exist **at snapshot time**
(`fs.existsSync` on the Core-reported path). A child without a `sessionFile`,
or whose file is gone, or whose probe raised, is omitted — an unverified path
is never offered as readable history. This capability is the only place a
transcript path appears on the wire; `children.snapshot` carries none.
Consumers must still re-check the path when they read it.

### `usage.children` v1

```json
{
  "agents": [
    {
      "id": "8f1c…",
      "tokens": { "input": 1100, "output": 240, "cacheRead": 900, "cacheWrite": 0, "total": 1340 },
      "costUsd": 0.021,
      "costKind": "reported"
    }
  ]
}
```

- One row per observed child, scoped to that child only. The parent session is
  never included here, and this provider never sums children together, so a
  consumer cannot double-count child spend by adding it to parent usage.
- `tokens` values are numbers or `null`; `null` means **unknown**, never zero.
  `cacheRead`/`cacheWrite` are `null` when Core reports no cache accounting.
- `costUsd` is a number or `null`; `costKind` is `reported` when the child
  reported a cost, `unknown` when it did not. `estimated` is reserved for
  adapters that derive cost from tokens; this provider never estimates and
  never emits it.
- A child without stats yields all `null` tokens, `costUsd: null`, and
  `costKind: "unknown"`.

### `background.status` v1

```json
{ "state": "active" }
```

- `active` when at least one observed child is `alive`; `idle` when the source
  is loaded and no observed child is alive.
- The "we cannot know" case is the **absence of this capability** (Core
  subagents not loaded), never `idle`. A consumer must treat a missing
  capability as unknown and must not stop a runtime because it is absent.

### `taskWorkspace.current` v1

```json
{
  "state": "ok",
  "repos": [
    {
      "name": "agent-kit",
      "path": "/home/user/.agent-kit/tasks/feat~2Fwork/agent-kit",
      "branch": "feat/work",
      "classification": "MANAGED_TASK_WORKTREE",
      "slot": null,
      "headSha": "0123456789abcdef0123456789abcdef01234567"
    }
  ]
}
```

- `state` — `"ok" | "none" | "missing"`. `none` (no session selection) and
  `missing` (selection recorded, workspace gone) always carry `repos: []`.
- The projection is the same session-scoped `current` projection the inherited
  inspection channel serves: a managed session cwd, otherwise the most recent
  successful `ensure_task_repo` on the current session branch. Nothing is
  inferred from the global task catalog, branch names, or modification times.
- While no session is bound (before `session_start`, after
  `session_shutdown`) the answer is `none`; the process cwd is not a session
  selection.
- `branch` is `""` for a detached HEAD; `headSha` is `null` when Git facts
  could not be read.
- **Not part of v1:** active RepoOwner refs (`owners`), dirty state, upstream,
  `detached`, repo `kind`, and task `identity`/`workspace`. RepoOwner
  enrichment is a separate capability if a consumer ever needs it; it must not
  be smuggled into this one.
- `path` values are absolute. They are candidate read roots, not permissions:
  a consumer that gates file access on them must re-verify the roots, the
  session identity, and path containment on its own side.

## Errors

The provider throws errors with a `code` property; the bridge maps them:
`provider_not_ready` passes through, any other error becomes
`snapshot_failed`. `incompatible_version` and `unsupported_feature` are
provider-side refusals that the bridge normally decides earlier from the
announced capabilities; when they reach the bridge they are reported as
`snapshot_failed`, never as data. Messages never contain Core internals beyond
the feature name.

## Relation to `inspection-channel`

[`inspection-channel`](../inspection-channel/README.md) is the legacy
area-based channel (`{op:"snapshot", area}` over inherited descriptors). It is
deprecated for node usage and replaced by this provider plus the controller
bridge; it stays in place, unchanged, for nodes and sessions that still speak
that protocol. The two are independent: this provider never imports it, never
reads descriptor environment variables, and never serves two readers on one
descriptor pair.

## Verification

```sh
node --test 'extensions/inspection-provider/*.test.ts'
```

- `index.test.ts` — hello body, every capability payload, capability
  availability, inertness (no registry, wrong version, wrong shape, throwing
  registry, refused registration), re-registration/token ownership, the
  factory's lack of model surface, the no-CLI/no-own-subprocess guarantee, and
  the lazy Core seam import in a fresh bridge-less process;
- `identity.test.ts` — identity resolution on real fixture layouts
  (repository, linked worktree, packed ref, detached HEAD, snapshot release,
  symlinked install pointing at a checkout or at a pinned release, declared
  package version, nothing at all, escaping ref);
- `cross-graph.test.ts` — two real jiti module graphs share one bridge
  registry, a provider evaluated in one graph is served from it, and a reload
  in a third graph re-registers without duplicating the entry.
