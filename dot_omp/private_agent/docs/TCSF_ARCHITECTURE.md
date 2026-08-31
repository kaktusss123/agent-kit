# TCSF Architecture

TCSF is the durable controller for approved task execution. The extension is loaded from `extensions/tcsf/index.ts`; application code composes pure domain transitions with explicit ports and Bun/Git/OMP adapters.

## State ownership

- `core/` owns serializable task/run types, legal transitions, retry policy, failure classes, and decision validation. It does not import OMP, Git, Bun, or filesystem code.
- `app/factory.ts` owns the workflow and writes task/run artifacts through `ArtifactStore`.
- `ports/` define the seams for agent sessions, execution hosts, run-driver supervision, workspaces, verification, review, decisions, and artifacts.
- `adapters/fs-artifact-store.ts` persists task JSON, run JSON, events, and bounded verification/review output under the configured TCSF root. Writes use temporary files followed by rename.
- `adapters/git-workspace.ts` validates clean repositories and base SHAs, creates detached worktrees, captures changes, enforces approved writable scopes, and restores unauthorized changes.
- `adapters/omp/rpc-runtime.ts` launches OMP RPC sessions with isolated session directories. `createSession` obtains a durable session reference and closes its discovery transport; `resumeSession` opens the transport used for turns.
- `adapters/omp/reviewer.ts` opens a fresh no-tools reviewer session and accepts only schema-validated JSON.
- `adapters/local-run-driver-host.ts` starts a managed Bun driver process with a persisted identity manifest. `run-driver-process.ts` advances the durable workflow and exits at a terminal or waiting state.

## Workflow

The controller advances one persisted stage per driver iteration:

`validate → prepare_workspaces → implement → verify → review → candidate_validate → ready_for_acceptance`

Critical decisions and operator waits are persisted as waiting stages. Verification is factory-owned and checks explicit exit codes. Review is independent from implementation, receives Git evidence, and requires a structured result. Self-change candidate validation launches a fresh OMP process with an explicit candidate extension path and isolated session directory, then reruns deterministic acceptance commands before the run becomes terminal.

## Writer and foreground semantics

The controller has one persisted run lease. The local execution host records and supervises the actual OMP worker PID; it does not create a second OMP writer. `/tcsf_attach` acquires an operator writer lease and prints a same-session resume command; `/tcsf_return` releases the handoff state. Autonomous driver recovery is performed with `/tcsf_resume`.

## Compatibility boundary

The legacy `task-runtime` extension is not part of the active extension namespace. It is retained only as historical baseline material under `docs/history/` after the TCSF loader probe succeeds. TCSF owns the active command and tool names; deprecated aliases are warnings only and do not implement the old lifecycle.
