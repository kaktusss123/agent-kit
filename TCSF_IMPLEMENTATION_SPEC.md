# TCSF implementation specification

Status: approved architecture and implementation contract

Product name: TCSF, Too Complex Software Factory

Primary initial environment: Oh My Pi running in Warp

Future compatible environments: Pi, HERDR, other agent runtimes and execution hosts that satisfy the contracts in this document

## 1. Instruction to the implementation agent

Implement this specification in the current dotfiles and active OMP runtime.

This is a proof-first task. Do not start by rewriting all current files. First inspect the repository, the installed OMP package, its public types, its CLI help, and the actual runtime paths on this machine. Then run the capability probes defined in this document inside isolated temporary repositories and isolated session storage.

For every technical hypothesis:

1. Record the claim, evidence, experiment, success criteria, and fallback before changing production code.
2. Run the smallest experiment that can disprove the claim.
3. If the claim is confirmed, implement against the confirmed behavior.
4. If the claim is rejected, execute the specified fallback without asking the user unless the fallback changes a product contract, trust boundary, irreversible operation, or accepted architectural invariant.
5. If both the preferred path and the safe fallback fail, persist an evidence-backed blocker and request a human decision.

The user should not have to supervise routine implementation, verification, review, repair, restart, or recovery. The target is a run that can continue unattended for up to twelve hours and stops only for a critical semantic decision or an external condition that has no safe automatic recovery.

The implementation agent is not allowed to weaken this contract because a local API is inconvenient. It may choose a smaller architecture-preserving adapter when a preferred API is unavailable.

## 2. Why this change exists

The current task runtime made a foreground OMP TUI session part of the execution invariant. This improved interactive handoff, but it made autonomous self-testing depend on a human being present in a live session.

TCSF replaces that assumption with a stronger one:

```text
An agent execution is durable and foregroundable.
It may run while no operator is attached.
An operator can inspect or take control of the same logical agent session.
```

"Background" is not a worker type in TCSF. It only means that no operator is currently attached.

The factory owns process, state, verification, retry, recovery, and promotion mechanics. Agent models own semantic work inside bounded roles.

## 3. Product boundary

### 3.1 Cracker is upstream of TCSF

Cracker owns task understanding and human product decisions:

```text
raw request
-> repository and external research
-> clarification with the user
-> explicit semantic decisions
-> approved immutable implementation contract
```

TCSF owns the automated SDLC after approval:

```text
approved contract
-> workspace preparation
-> implementation
-> deterministic verification
-> independent review
-> bounded repair
-> candidate validation when required
-> acceptance packet
```

Cracker is not a mandatory internal stage of TCSF. TCSF consumes an approved contract through a replaceable contract source. The current Cracker may produce that contract, but another planner, a human, a Jira integration, or a future service may replace it.

TCSF MUST NOT ask the user to repeat product decisions already present in the approved contract.

### 3.2 TCSF stops before publication by default

The initial production policy stops at:

```text
READY_FOR_ACCEPTANCE
```

For repository work, this is equivalent to "ready for commit or merge request review". TCSF MUST NOT push, merge, deploy, publish, or modify a protected branch without a separate explicit policy and approval.

## 4. Known facts and locally pending hypotheses

The following facts are supported by current upstream documentation and source, but the implementation agent still MUST verify behavior against the installed versions on this machine.

1. OMP exposes non-interactive prompt execution, persisted sessions, resume and continue options, JSON event output, RPC mode, and a public SDK with session management.
2. OMP RPC is intended for programmatic integrations and exposes lifecycle events, prompts, tool activity, cancellation, and session operations.
3. HERDR can start agents in terminal panes, retain session state, wait for completion, focus or attach to an agent, and resume supported agent sessions, including OMP.
4. SSSF keeps orchestration in deterministic code while each semantic worker remains an ordinary Pi agent session. Tests are code-owned phases, and correction can continue in the same agent session.
5. The current local task runtime already has durable artifacts, frozen approvals, worktree preparation, write policy work, and deterministic verification concepts that should be preserved rather than discarded.

Locally pending hypotheses are listed in section 23. Production code MUST NOT depend on a pending hypothesis.

### 4.1 Architecture decisions already made

These are architectural decisions, not open implementation hypotheses.

#### Durable foregroundable execution instead of foreground-only or detached-only workers

Foreground-only execution was rejected because the factory could not continue after the initiating TUI disappeared. Detached-only execution was rejected because the operator could not inspect or take over the actual worker. Copying a summary into a new foreground session was rejected because it loses the original session's tool state, corrections, and conversational continuity.

The selected model keeps one durable logical session and allows either live attachment or safe same-session handoff.

#### Separate `AgentRuntime` and `ExecutionHost`

A single `Subagent` abstraction was rejected because it would bind conversation continuity to one process and one terminal implementation. OMP, Pi, HERDR, and a plain local process vary independently. Session resume and terminal attachment must therefore remain separate contracts.

#### Cracker outside the automated SDLC

A single workflow that mixes grokking, product decisions, implementation, and acceptance was rejected. Product ambiguity requires a human decision authority, while implementation and repair should run unattended after approval. The boundary is the frozen approved contract.

#### Fixed workflow instead of a generic workflow engine

A DAG DSL was rejected. The required lifecycle is known, and a generic engine would add recovery and migration complexity before TCSF has completed real tasks. The code should expose explicit state transitions that can later be composed, not a second PiEWF-like framework.

#### RPC-first autonomous OMP integration

In-process control was not selected as the default because process isolation, cancellation, and candidate validation are harder. CLI one-shot execution was not selected as the default because event and lifecycle control may be weaker. HERDR was not selected as a core dependency because the current product must work with OMP and Warp alone.

RPC is preferred only if the installed implementation passes the contract probes. Public SDK and CLI resume remain pre-approved fallbacks.

#### Automatic verification after terminal turns

A model-owned `task_submit` step was rejected as a required gate. It made workflow progress depend on prompt compliance. TCSF automatically inspects changes and runs verification after a terminal implementation turn. The model may report progress, but it cannot suppress the gate.

#### Stable parent and candidate child

Hot-reloading the factory from files it is editing was rejected. A candidate that controls its own evaluator can hide loader, state, or recovery failures. The stable installed runtime remains the parent and evaluates a fresh isolated candidate process.

#### Warp as operator terminal, not control plane

Tying correctness to Warp panes or notifications was rejected because no stable control contract has been established. Warp remains the normal human terminal. A later adapter may improve UX without changing the workflow.

### 4.2 Confidence threshold for experiments

The experiments in section 23 are authorized because each one has all of the following:

- primary-source or installed-type evidence that the capability probably exists;
- a small isolated experiment that cannot damage product repositories or active sessions;
- an explicit success condition;
- a safe fallback selected before the experiment;
- a defined stop condition when both paths fail.

The confidence claim is not that every preferred API will pass. The confidence claim is that each probe is the smallest safe way to choose among documented implementations without making the production architecture depend on guesswork. The agent MUST NOT add speculative probes against undocumented internals merely because a preferred result did not appear.

## 5. Architectural invariants

### 5.1 Durable foregroundable execution

Every production agent execution MUST have:

- a stable TCSF execution ID;
- a durable logical agent session reference;
- a persisted status;
- an execution host reference;
- a single-writer lease;
- bounded turn and retry policy;
- durable event and diagnostic records;
- cancellation or safe abandonment semantics;
- a foreground capability of `live` or `handoff`;
- recovery behavior after controller or worker process failure.

A terminal pane, PID, OMP process, or Warp tab is not the identity of the agent session.

### 5.2 Logical session and physical host are separate

TCSF MUST model these separately:

```text
AgentSession
    owns conversation continuity and runtime session identity

ExecutionHost
    owns process, transport, terminal pane, attach, detach, and liveness
```

A logical session may survive multiple host processes. A host may be replaced after a crash while the same session is resumed.

### 5.3 One writer per logical session

At most one controller or operator may send input to a logical agent session at a time.

Before foreground handoff, the autonomous controller MUST:

1. wait until the current turn is terminal or interrupt it explicitly;
2. flush and close its transport;
3. release its writer lease;
4. persist the handoff state;
5. allow the operator client to acquire the lease.

The reverse process is required before autonomous execution resumes.

TCSF MUST fail closed on concurrent writers. It MUST NOT rely on session-file corruption detection after the fact.

### 5.4 Deterministic controller, semantic workers

Code owns:

- stage order;
- state transitions;
- retry counters;
- time and attempt limits;
- worktree creation and validation;
- required command execution;
- exit-code interpretation;
- scope enforcement;
- review routing;
- decision classification policy;
- persistence and recovery;
- final readiness state.

Agents own:

- repository understanding;
- implementation choices inside the approved contract;
- code changes;
- semantic diagnosis of failures;
- review findings;
- requests for decisions when the contract cannot resolve a material semantic conflict.

The implementation prompt MUST NOT be the only place where a mechanical invariant exists.

### 5.5 Interfaces are replaceable, not decorative

Introduce an interface only where at least two real implementations exist now, or where a tested adapter boundary is required to avoid binding the core to OMP, Pi, HERDR, Warp, Git, or local filesystem behavior.

Do not add a dependency injection framework. Construct concrete adapters explicitly in the extension entrypoint.

### 5.6 Stable runtime evaluates candidate runtime

When TCSF modifies its own code or OMP integration:

- the currently installed stable TCSF controls the run;
- changes occur in an external candidate worktree;
- the running stable implementation is not hot-reloaded from edited files;
- a fresh isolated runtime loads the candidate implementation;
- the candidate runs scenario tests in fixture repositories;
- the stable parent evaluates machine evidence;
- the candidate cannot promote, merge, or declare itself production-ready.

### 5.7 Evidence before claims

An acceptance criterion is PASS only when the required behavior was executed and the evidence is persisted. Code inspection, intent, compilation, or a model statement is not a substitute for a runtime test when the criterion concerns runtime behavior.

## 6. Core ports

Use TypeScript interfaces or structurally compatible types. Keep the types small. Pure helper functions do not need interfaces.

### 6.1 AgentRuntime

```ts
export interface AgentRuntime {
  readonly kind: string;

  createSession(input: CreateAgentSessionInput): Promise<AgentSessionRef>;
  resumeSession(ref: AgentSessionRef): Promise<AgentSessionHandle>;
  sendTurn(handle: AgentSessionHandle, input: AgentTurnInput): Promise<AgentTurnRef>;
  waitForTurn(handle: AgentSessionHandle, turn: AgentTurnRef): Promise<AgentTurnResult>;
  interruptTurn(handle: AgentSessionHandle, turn: AgentTurnRef): Promise<void>;
  inspectSession(ref: AgentSessionRef): Promise<AgentSessionStatus>;
  close(handle: AgentSessionHandle): Promise<void>;
}
```

Required semantics:

- `AgentSessionRef` is serializable and sufficient to resume after process restart.
- `waitForTurn` returns only after a terminal agent event, transport failure, timeout, or cancellation.
- tool and lifecycle events are recorded or made available to the controller.
- runtime-specific session paths and IDs remain adapter data.
- a controller restart does not require replaying the whole transcript into a new session.

Initial candidates:

```text
OmpRpcAgentRuntime
OmpSdkAgentRuntime, fallback only if its probe passes
FakeAgentRuntime, tests
```

Future candidate:

```text
PiAgentRuntime
```

### 6.2 ExecutionHost

```ts
export interface ExecutionHost {
  readonly kind: string;

  start(input: StartHostInput): Promise<HostRef>;
  inspect(ref: HostRef): Promise<HostStatus>;
  stop(ref: HostRef, mode: "graceful" | "force"): Promise<void>;
  acquireWriter(ref: HostRef, owner: WriterOwner): Promise<WriterLease>;
  releaseWriter(lease: WriterLease): Promise<void>;
  foreground(ref: HostRef, input: ForegroundRequest): Promise<ForegroundResult>;
}
```

`foreground` has three capability levels:

```ts
export type ForegroundCapability = "live" | "handoff" | "none";
```

Meaning:

- `live`: the operator attaches to the currently running host without replacing it.
- `handoff`: TCSF pauses at a safe boundary, releases the writer lease, and opens or provides a deterministic way to open the same logical session in an interactive client.
- `none`: allowed only for test adapters and non-production probes.

Initial candidates:

```text
LocalRpcHost
OmpInteractiveHost
FakeExecutionHost
```

Conditional candidate:

```text
HerdrExecutionHost
```

Warp is an operator terminal in the first implementation. It is not a required `ExecutionHost` and MUST NOT be part of correctness.

### 6.3 WorkspacePort

The workspace port owns Git facts and task worktrees:

```ts
export interface WorkspacePort {
  inspectRepo(path: string): Promise<RepoInspection>;
  prepareTaskWorkspaces(input: PrepareWorkspacesInput): Promise<WorkspaceSet>;
  validateWorkspaceSet(set: WorkspaceSet): Promise<void>;
  captureChanges(set: WorkspaceSet): Promise<ChangeSet>;
  restoreUnauthorizedChanges(input: RestoreUnauthorizedInput): Promise<RestoreResult>;
}
```

The default adapter uses Git CLI with explicit arguments and canonical paths.

### 6.4 ArtifactStore

```ts
export interface ArtifactStore {
  createTask(input: CreateStoredTaskInput): Promise<StoredTaskRef>;
  loadTask(taskId: string): Promise<TcsfTask>;
  saveTask(task: TcsfTask, expectedRevision: number): Promise<TcsfTask>;
  appendEvent(taskId: string, event: TcsfEvent): Promise<void>;
  writeArtifact(taskId: string, relativePath: string, data: Uint8Array): Promise<ArtifactRef>;
  readArtifact(ref: ArtifactRef): Promise<Uint8Array>;
}
```

Writes MUST be atomic. Manifest updates MUST use optimistic revision checks or an equivalent single-writer lock.

### 6.5 VerificationRunner

```ts
export interface VerificationRunner {
  run(input: VerificationRunInput): Promise<VerificationRunResult>;
}
```

It runs approved commands in the registered worktree, captures exit code and bounded output, persists complete output to artifacts, and never lets an LLM reinterpret a nonzero exit code as a pass.

### 6.6 HumanDecisionPort

```ts
export interface HumanDecisionPort {
  publish(request: DecisionRequest): Promise<void>;
  readResolution(decisionId: string): Promise<DecisionResolution | null>;
}
```

The initial OMP adapter may expose slash commands and TUI prompts. A future web, Slack, or remote service can replace it.

The workflow MUST persist a decision request before notifying the user. An open TUI prompt is not durable state.

### 6.7 ModelRouter

Use the existing model-routing boundary if available. Workflow code requests semantic slots such as `implementer`, `reviewer`, and `repair`. It MUST NOT encode provider-specific names.

### 6.8 RunDriverHost

The OMP command handler is a control surface, not the lifetime of an unattended run.

```ts
export interface RunDriverHost {
  start(input: StartRunDriverInput): Promise<RunDriverRef>;
  inspect(ref: RunDriverRef): Promise<RunDriverStatus>;
  stop(ref: RunDriverRef, mode: "graceful" | "force"): Promise<void>;
}
```

The initial implementation uses a managed local process with persisted PID identity, start token, log path, heartbeat, and run lease. A future HERDR or daemon adapter may host the same driver.

The driver process runs the deterministic `advanceRun` loop. It is not an LLM and does not need a conversational foreground. It MUST be observable, cancellable, and replaceable after failure.

## 7. Runtime composition

The extension entrypoint constructs concrete adapters and passes them to one application service:

```ts
const factory = new TcsfFactory({
  agentRuntime,
  executionHost,
  runDriverHost,
  workspace,
  artifacts,
  verification,
  decisions,
  modelRouter,
  clock,
});
```

Slash commands, model tools, a future scheduler, and tests call the same `TcsfFactory` operations. Do not duplicate lifecycle validation in each caller.

Target operations:

```ts
importApprovedContract(...)
startRun(...)
resumeRun(...)
getStatus(...)
requestForeground(...)
returnFromForeground(...)
resolveDecision(...)
cancelRun(...)
advanceRun(...)
```

`advanceRun` performs one bounded deterministic progression step. A long-running driver repeatedly calls it until the task reaches a terminal or waiting state.

`/tcsf_run` MUST persist the run before starting the driver. The command then starts or confirms one managed driver and returns control to the initiating OMP session. The run MUST continue if that OMP session closes.

The driver:

- acquires the run lease;
- writes a heartbeat;
- loops over bounded `advanceRun` calls;
- handles shutdown signals;
- exits on terminal or waiting state;
- writes stdout and stderr to bounded rotating or segmented artifacts;
- never owns product semantics.

A second driver for the same run fails on the lease. If the driver dies, `/tcsf_resume` or a future supervisor may start a replacement that reconciles durable state.

This split is required so the same workflow can run:

- from the current OMP command;
- from a headless local process;
- from a future daemon or scheduler;
- in deterministic tests.

## 8. Storage layout

Use a new namespace. Do not overload legacy task manifests.

Default root:

```text
~/.omp/tcsf
```

Allow an explicit `TCSF_HOME` override for tests and isolated candidate validation.

Task layout:

```text
~/.omp/tcsf/tasks/<task-id>/
├── task.json
├── events.jsonl
├── contract/
│   ├── packet.json
│   ├── spec.md
│   ├── evidence.md
│   ├── decisions.jsonl
│   └── verification.json
├── worktrees/
│   ├── <primary-repo-key>/
│   └── <target-repo-key>/
└── runs/
    └── <run-id>/
        ├── run.json
        ├── executions/
        │   └── <execution-id>.json
        ├── decisions/
        │   └── <decision-id>.json
        ├── verification/
        ├── reviews/
        ├── candidate-validation/
        └── reports/
```

Rules:

- factory artifacts do not enter product repositories by default;
- approved contract files are copied and hashed during import;
- mutable execution state never changes the approved contract copy;
- original source and reference repositories are not execution workspaces;
- old `~/.omp/tasks` state remains read-only unless a separate explicit importer handles one task;
- no automatic bulk migration is part of this implementation.

## 9. Core data model

### 9.1 Approved contract packet

```ts
export interface ApprovedContractPacket {
  schemaVersion: 1;
  taskId: string;
  title: string;
  approvalId: string;
  approvedAt: string;

  artifacts: {
    spec: HashedInputArtifact;
    evidence?: HashedInputArtifact;
    decisions?: HashedInputArtifact;
    verification: HashedInputArtifact;
  };

  repositories: RepositoryContract[];
  acceptanceCriteria: AcceptanceCriterion[];
  policy: TaskPolicy;
}
```

Repository roles:

```ts
export type RepositoryRole = "primary" | "target" | "reference";
```

Writable roles are `primary` and `target`. Reference repositories are read-only.

The packet must record canonical source path, base SHA, role, repo key, and approved writable scope where the contract limits scope.

TCSF verifies every artifact hash and repository base before work begins.

### 9.2 Task state

```ts
export type TaskPhase =
  | "approved"
  | "preparing"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "candidate_validating"
  | "waiting_for_decision"
  | "waiting_for_operator"
  | "ready_for_acceptance"
  | "completed"
  | "failed"
  | "cancelled";
```

`completed` requires an explicit acceptance operation in the initial policy. Automated SDLC success produces `ready_for_acceptance`.

### 9.3 Run state

A task may have several runs over its lifetime. Only one nonterminal run may hold the task lease.

```ts
export interface TcsfRun {
  id: string;
  taskId: string;
  revision: number;
  status: RunStatus;
  currentStage: RunStage;
  createdAt: string;
  updatedAt: string;
  lease?: RunLease;
  counters: RunCounters;
  activeExecutionId?: string;
  blocker?: RunBlocker;
}
```

### 9.4 Execution record

```ts
export interface ExecutionRecord {
  id: string;
  runId: string;
  role: "implementer" | "reviewer" | "candidate-validator";
  purpose: string;
  status: ExecutionStatus;

  agentRuntimeKind: string;
  agentSession: AgentSessionRef;

  executionHostKind: string;
  host: HostRef;
  foregroundCapability: ForegroundCapability;

  writerLease?: WriterLeaseRecord;
  workspaceRoots: string[];
  readOnlyRoots: string[];

  createdAt: string;
  lastHeartbeatAt?: string;
  lastTerminalTurnAt?: string;
  finishedAt?: string;

  failure?: ClassifiedFailure;
}
```

Execution status:

```ts
export type ExecutionStatus =
  | "created"
  | "starting"
  | "running"
  | "idle"
  | "foregrounded"
  | "stopping"
  | "succeeded"
  | "failed"
  | "lost"
  | "cancelled";
```

### 9.5 Decision request

```ts
export interface DecisionRequest {
  id: string;
  taskId: string;
  runId: string;
  category: CriticalDecisionCategory;
  question: string;
  evidence: ArtifactRef[];
  options: DecisionOption[];
  recommendation: string;
  consequenceOfDelay: string;
  requestedAt: string;
  resumeStage: RunStage;
  status: "open" | "resolved" | "superseded";
}
```

The request must contain concrete options and a recommendation. "What should I do?" without evidence is invalid.

## 10. Fixed SDLC workflow

Do not build a generic DAG engine. Implement one explicit workflow.

```text
import approved contract
        |
        v
validate contract and repositories
        |
        v
prepare task worktrees
        |
        v
create or resume implementer session
        |
        v
implementation turn
        |
        v
scope and repository integrity check
        |
        v
deterministic verification
        |
        +---- fail ----> same logical implementer session, bounded repair
        |
        v
fresh independent reviewer session
        |
        +---- blocking findings ----> same implementer session
        |                              -> verification again
        |                              -> fresh review attempt
        |
        v
candidate runtime validation, only for self-change
        |
        +---- fail ----> same implementer session, bounded repair
        |
        v
READY_FOR_ACCEPTANCE
```

### 10.1 Implementation turn completion

Do not require the implementer to remember a `/task_submit` ritual.

When the agent turn reaches a terminal event, the controller automatically:

1. captures Git changes;
2. checks write scope and protected repositories;
3. runs required verification;
4. routes failures to the same logical implementer session;
5. advances to review only after all required checks pass.

An optional `tcsf_checkpoint` tool may provide progress metadata, but workflow correctness MUST NOT depend on it.

### 10.2 Same-session repair

All deterministic verification failures and reviewer findings return to the same logical implementer session while that session remains healthy.

A new host process may resume the session after a crash. That still counts as the same logical session.

Create a fresh implementer session only when:

- the runtime proves the session is corrupt or irrecoverable;
- a protocol failure persists after one repair turn;
- the approved contract changes and a new run is required;
- the user explicitly requests a reset.

The factory records the reason and links the replacement execution to its predecessor.

### 10.3 Independent review

The reviewer:

- uses a fresh logical session;
- has read-only access;
- receives the approved contract, actual diff, verification evidence, and prior resolved findings;
- returns a structured result through `tcsf_review_result` or another schema-validated channel;
- does not edit code;
- does not approve merely because tests pass.

Required result:

```ts
interface ReviewResult {
  verdict: "pass" | "fail" | "decision_required";
  summary: string;
  findings: ReviewFinding[];
}
```

Each blocking finding contains file or behavior evidence, violated contract or invariant, severity, and a concrete expected correction.

A new reviewer session is used for each review round. This avoids carrying the previous review's conversational commitment into the next verdict.

### 10.4 Conditional security review

Do not create a permanent reviewer zoo.

Run a separate security review only when deterministic task policy marks a security-sensitive change, for example:

- authentication or authorization;
- secrets or credentials;
- filesystem or shell policy;
- network trust boundaries;
- destructive data operations;
- code execution or plugin loading.

Use the same reviewer role with a security skill or review lens unless tool permissions require a separate role.

## 11. Human decision policy

The factory asks the user only when a decision is critical or safe automation is impossible.

### 11.1 Critical semantic decisions

These always require the user or another explicitly authorized decision authority:

- change to approved observable behavior;
- public API, data contract, compatibility, or migration semantics not resolved by the contract;
- security or trust-boundary change;
- destructive or irreversible action;
- scope expansion into an unapproved repository or subsystem;
- amendment of acceptance criteria or required verification;
- architecture change that adds, removes, or violates a TCSF invariant or port boundary;
- publication, push, merge, deploy, or protected-branch mutation under the initial policy;
- inability to prove a required acceptance criterion;
- exhausted bounded semantic repair where materially different solutions remain.

### 11.2 Decisions the agent owns

Do not stop for:

- file and symbol selection within approved scope;
- local refactoring that preserves behavior;
- test implementation details;
- choosing between confirmed OMP adapter paths according to the selection policy;
- retrying a transient provider or process failure within limits;
- changing a model according to the configured model-routing policy;
- formatting, lint, type, or focused test repairs;
- replacing a rejected technical hypothesis with its pre-approved safe fallback;
- creating additional internal tests or diagnostics.

### 11.3 Operator blockers are not semantic decisions

Use `waiting_for_operator` for conditions such as:

- credentials unavailable;
- all configured providers unavailable after bounded retries;
- disk full;
- required executable absent with no install authority;
- repository contains user changes that cannot be preserved safely;
- a process cannot be killed or a lease cannot be recovered safely.

The status report must state the exact external action needed. Do not manufacture product options for an operational fault.

## 12. Failure classification and retry policy

Classify failures before retrying.

```ts
export type FailureClass =
  | "infrastructure"
  | "protocol"
  | "semantic"
  | "verification"
  | "policy"
  | "workspace"
  | "candidate_validation"
  | "cancelled";
```

Default limits are configuration, not model decisions:

```text
infrastructure retries per operation: 3
protocol repair attempts per execution: 1
verification repair turns: 5
review repair rounds: 3
candidate validation repair rounds: 2
maximum uninterrupted run wall time: 12 hours
heartbeat grace: implementation-defined after probes, finite
```

Rules:

- transient infrastructure retries may use bounded backoff;
- a protocol failure does not consume semantic repair count;
- rerunning a failing verification command without a code or environment change does not consume another repair turn, it is rejected as a no-op retry;
- policy violations fail closed and require rollback or a new clean workspace;
- exhausted limits produce a durable blocker and an evidence packet;
- recursive unbounded workflow execution is forbidden.

## 13. Recovery and re-entry

The controller MUST be restartable.

On startup or `/tcsf_resume`:

1. load task and active run;
2. acquire the run lease or fail with the current owner;
3. inspect worktrees and protected repositories;
4. inspect the active execution host;
5. inspect or resume the logical agent session;
6. reconcile event history with current state;
7. continue from the last completed durable stage.

Required recovery cases:

- controller exits while worker is running;
- worker process exits while session files remain valid;
- machine restarts after a terminal turn but before verification;
- verification finishes but manifest update fails;
- reviewer process dies;
- foreground operator closes the session without returning control;
- partially prepared multi-repository worktrees;
- stale lease with no live owner.

Use idempotent stage operations. Persist stage-start and stage-result events. A repeated stage may reuse valid output but MUST revalidate external state.

## 14. Foreground and operator control

### 14.1 Attach is optional for execution, mandatory as a capability

An autonomous run does not require an open TUI. Every production worker still needs a tested way to become foregrounded.

### 14.2 Preferred live attach

When `HerdrExecutionHost` or another host supports live attach:

```text
/tcsf_attach <execution-id>
-> acquire operator intent
-> host focuses or attaches the pane
-> execution continues in the same process and logical session
```

The controller remains the state owner but MUST not send turns while the operator owns the writer lease.

### 14.3 OMP handoff attach

When live attach is unavailable, OMP handoff is valid:

```text
controller waits for idle
-> controller closes RPC or SDK handle
-> writer lease moves to operator
-> same OMP session is resumed interactively
-> operator works in Warp or another terminal
-> operator invokes return or exits at a recorded safe point
-> controller reopens the same logical session
```

`/tcsf_attach` SHOULD open the session through a supported public OMP API if the local probe confirms it.

Fallback:

- persist an exact resume command and cwd;
- show it to the user;
- keep the run in `waiting_for_operator` until lease transfer is confirmed.

The fallback is acceptable because attach is exceptional and execution correctness does not depend on Warp automation.

### 14.4 Proving continuity

The real handoff E2E must use a nonce known only to the pre-handoff conversation. After interactive foreground work and autonomous reacquisition, the same logical session must recall or expose that nonce through persisted session history.

A transcript summary copied into a new session does not satisfy this criterion.

## 15. OMP adapter selection

Use evidence, not preference.

### 15.1 Autonomous runtime ranking

Choose the first adapter that passes its complete contract suite:

1. `OmpRpcAgentRuntime` with `LocalRpcHost`.
2. `OmpSdkAgentRuntime` with a tested isolated host.
3. repeated OMP CLI JSON turns with durable `--resume` semantics.

`OmpInteractiveHost` based on `ctx.newSession` is an operator mode. It does not satisfy autonomous execution by itself.

### 15.2 Why RPC is preferred

RPC is the preferred initial path because it gives the controller a process boundary, structured events, cancellation, and explicit session operations. It also makes stable-runtime versus candidate-runtime isolation easier to test.

This preference is conditional on installed-version probes. Do not force RPC through undocumented internals.

### 15.3 UI and approval behavior

Autonomous workers MUST NOT block on an invisible OMP TUI prompt.

Preferred behavior:

- routine permissions are resolved by the configured safe worker policy;
- material choices use `tcsf_request_decision` and durable TCSF decisions;
- RPC UI requests are bridged only if the installed protocol provides a reliable host callback.

Fallback:

- reject any unexpected runtime UI request as a classified protocol blocker;
- persist its payload;
- do not wait forever on stdin.

### 15.4 Session identity

Store all runtime identifiers needed for resume, but expose only opaque `AgentSessionRef` to core code.

Do not assume that a display session ID, file path, and resume argument are interchangeable. The adapter proves and owns the conversion.

## 16. HERDR and Warp

### 16.1 HERDR

HERDR is a conditional execution-host adapter, not a TCSF dependency.

Implement `HerdrExecutionHost` only when all of these are true:

- the binary is installed or already declared as a project dependency;
- the installed version exposes documented agent start, prompt, wait, inspect, attach, and session persistence behavior;
- an OMP agent can be started and attached in an isolated smoke test;
- TCSF can obtain stable host and session identifiers;
- writer ownership can be enforced.

If any condition fails, use OMP handoff attach and record HERDR as unavailable. Do not ask the user unless installing or changing HERDR is required for a requested acceptance criterion.

### 16.2 Warp

Warp is the default human terminal for the first release.

TCSF MAY generate a Warp launch configuration or an exact command for operator convenience if this uses documented behavior. TCSF MUST NOT depend on Warp pane APIs, notifications, or undocumented automation for execution correctness, recovery, or persistence.

A future `WarpExecutionHost` is allowed only after a stable control API is found and tested.

## 17. Self-development mode

A task is a self-change when it modifies TCSF, OMP extensions used by TCSF, its skills, its runtime adapters, or its active configuration contract.

### 17.1 Stable parent and candidate child

```text
stable installed TCSF
-> candidate Git worktree
-> implementation in candidate
-> ordinary deterministic checks
-> ordinary independent review
-> isolated candidate runtime
-> candidate scenario pack
-> stable parent evaluates evidence
-> READY_FOR_ACCEPTANCE
```

### 17.2 Isolation requirements

Candidate validation MUST isolate at least:

- TCSF task root;
- OMP session directory;
- candidate extension loading path;
- test repositories and worktrees;
- runtime logs;
- model/tool configuration when the installed OMP API supports an explicit isolated profile.

The implementation agent MUST probe exact supported flags and environment variables. It MUST NOT invent names based on memory.

Fallback hierarchy:

1. explicit OMP candidate extension and session-directory flags;
2. temporary home directory plus explicit candidate extension paths;
3. a repository-provided doctor or loader harness that starts a fresh process and imports the candidate entrypoint without touching active runtime state.

If no method can prevent candidate code from replacing or mutating the stable active runtime, self-development acceptance is blocked and requires a human architecture decision.

### 17.3 Candidate scenario pack

At minimum run:

```text
C-01 extension loads exactly once
C-02 expected commands and tools are registered
C-03 approved fixture task runs without an existing interactive session
C-04 verification failure returns to the same logical implementer session
C-05 fresh reviewer rejects a seeded defect and the repair loop corrects it
C-06 critical decision persists, pauses, resolves, and resumes after process restart
C-07 worker process death resumes the same logical session
C-08 foreground handoff preserves session continuity
C-09 protected source and reference repositories remain unchanged
C-10 stable runtime files and state remain unchanged
```

The candidate's own final message is not evidence. The stable parent reads event logs, Git state, exit codes, and adapter results.

### 17.4 No self-promotion

Self-development ends at `ready_for_acceptance`. The candidate cannot:

- copy itself over the active runtime;
- change the stable source checkout;
- merge its branch;
- push;
- mark itself accepted.

## 18. Git, write policy, and repository integrity

Preserve and strengthen the current worktree safety model.

### 18.1 Preflight

Before creating the first worktree:

- resolve every repository to canonical Git top-level;
- verify approved base SHA;
- detect duplicate canonical paths and repo-key collisions;
- inspect cleanliness;
- fail safely when user changes cannot be preserved;
- preflight all repositories before mutating any.

### 18.2 Worktrees

Create worktrees only for writable roles.

Default path:

```text
~/.omp/tcsf/tasks/<task-id>/worktrees/<repo-key>
```

Reference repositories receive no worktree.

Worktree creation is idempotent. Existing recorded worktrees are validated before reuse. Unexpected branches or paths fail closed.

### 18.3 Runtime write protection

Enforce allowed roots at two layers where OMP supports them:

1. pre-tool policy for `edit`, `write`, and known mutation tools;
2. Git and filesystem integrity comparison after every agent turn.

Bash cannot be treated as harmless. After each writer turn:

- capture actual Git changes in writable worktrees;
- verify original and reference repositories against their protected fingerprint;
- detect tracked, untracked, HEAD, and branch changes;
- restore only agent-introduced unauthorized changes when safe;
- never use a destructive reset that can erase pre-existing user work.

Implementation-phase protected repositories SHOULD be clean before the writer starts. If not, require a safe isolation decision before execution.

### 18.4 Scope authority

Model-reported `filesChanged` is advisory. Git state is authoritative.

## 19. Commands and model tools

### 19.1 Human commands

Required:

```text
/tcsf_run <approved-packet-or-task-id>
/tcsf_status [task-id]
/tcsf_resume <task-id>
/tcsf_attach <execution-id>
/tcsf_return <execution-id>
/tcsf_decide <decision-id>
/tcsf_cancel <task-id>
/tcsf_accept <task-id>
```

Command handlers are thin adapters over `TcsfFactory`.

Compatibility aliases MAY remain temporarily:

```text
/task_handoff -> /tcsf_run
/task_status  -> /tcsf_status
```

Aliases must display a deprecation notice and call the same application service. Do not keep a second implementation.

### 19.2 Model tools

Required:

```text
tcsf_status
tcsf_request_decision
tcsf_review_result
tcsf_checkpoint
```

`tcsf_request_decision` validates category, evidence, options, and recommendation. The implementer cannot mutate the approved contract through this tool.

`tcsf_review_result` is available only to a bound reviewer execution.

`tcsf_checkpoint` records optional progress and diagnostics. The factory must still recover without it.

Do not expose a model tool that directly marks a task completed, accepted, or verified.

## 20. Skills and roles

Remove `V2` from active skill, agent, command help, notification, and architecture text.

### 20.1 Cracker skill

Cracker remains upstream and read-only with respect to product code.

Its active skill should say:

- discover facts from repositories and tools;
- ask the user only for semantic decisions;
- produce an approved contract packet;
- do not launch implementation;
- do not describe TCSF internals as part of product requirements.

No active Cracker text may refer to "V2".

### 20.2 Implementer skill

The implementer skill becomes smaller because workflow mechanics move to code.

It should say:

- read the frozen contract and current failure packet;
- confirm cwd and allowed worktrees;
- implement the contract;
- use existing project conventions;
- ask for a decision only through `tcsf_request_decision` and only under the critical policy;
- do not edit contract artifacts;
- do not spawn a competing orchestrator;
- end the turn when the code is ready for factory-owned verification.

It must not tell the model to remember stage sequencing, retry counts, or completion transitions.

### 20.3 Reviewer skill

The reviewer is fresh-context and read-only.

It reviews:

- approved contract compliance;
- correctness and edge cases;
- tests and verification adequacy;
- unintended behavior or scope;
- maintainability and existing conventions;
- security when the injected policy requests that lens.

It returns only through the structured review tool or validated result contract.

### 20.4 No LLM coordinator role

The factory coordinator is application code. Do not create an LLM role named orchestrator or coordinator to remember this workflow.

## 21. Target package layout

Adapt names only when the repository has a stronger established convention.

```text
private_agent/
├── extensions/
│   └── tcsf/
│       ├── index.ts
│       ├── runner.ts
│       ├── core/
│       │   ├── types.ts
│       │   ├── state.ts
│       │   ├── failures.ts
│       │   ├── decisions.ts
│       │   └── policy.ts
│       ├── ports/
│       │   ├── agent-runtime.ts
│       │   ├── execution-host.ts
│       │   ├── run-driver-host.ts
│       │   ├── workspace.ts
│       │   ├── artifact-store.ts
│       │   ├── verification.ts
│       │   └── human-decision.ts
│       ├── app/
│       │   ├── factory.ts
│       │   ├── lifecycle.ts
│       │   ├── recovery.ts
│       │   ├── review-loop.ts
│       │   └── self-development.ts
│       ├── adapters/
│       │   ├── omp/
│       │   │   ├── rpc-runtime.ts
│       │   │   ├── sdk-runtime.ts
│       │   │   ├── interactive-host.ts
│       │   │   ├── session-ref.ts
│       │   │   └── protocol.ts
│       │   ├── local-process-host.ts
│       │   ├── local-run-driver-host.ts
│       │   ├── herdr-host.ts
│       │   ├── fs-artifact-store.ts
│       │   ├── git-workspace.ts
│       │   ├── shell-verification.ts
│       │   └── omp-human-decisions.ts
│       ├── bindings/
│       │   ├── commands.ts
│       │   └── tools.ts
│       ├── probes/
│       │   ├── index.ts
│       │   └── hypotheses.ts
│       └── tests/
│           ├── contract/
│           ├── unit/
│           ├── integration/
│           └── fixtures/
├── skills/
│   ├── cracker/SKILL.md
│   ├── implementer/SKILL.md
│   └── reviewer/SKILL.md
└── docs/
    ├── TCSF_ARCHITECTURE.md
    ├── TCSF_OPERATIONS.md
    └── history/
```

Do not leave two active extensions registering the same commands or tools.

Move obsolete V2 documents to `docs/history/` or mark them clearly historical. Historical files may retain the old term because they are records, but no active skill, agent, runtime help, or normative document may use it.

## 22. Proof-first implementation sequence

Do not reorder these stages without evidence.

### Stage 0: baseline and safety snapshot

Actions:

- inspect current source and active runtime;
- record current Git status and HEAD;
- locate installed OMP CLI, package version, public types, CLI docs, SDK docs, RPC docs, extension loader, and current session storage;
- locate current task runtime files and tests;
- run existing tests before modification;
- create an isolated fixture repo and isolated TCSF root.

Exit criteria:

- baseline report exists;
- existing failures are distinguished from new failures;
- no production behavior changed.

### Stage 1: hypothesis probe harness

Implement a small probe runner that writes machine-readable results. Run H-01 through H-11 from section 23.

Exit criteria:

- every mandatory hypothesis is `confirmed`, `rejected_with_fallback`, or `blocked`;
- no production adapter depends on a pending result;
- a blocked result includes exact evidence and why its fallback failed.

### Stage 2: pure core and storage

Implement:

- task and run state machines;
- event model;
- decision policy;
- retry counters;
- failure classification;
- artifact store with atomic revisions;
- fake ports and contract tests.

No real OMP worker starts in this stage.

Exit criteria:

- deterministic tests pass;
- restart and idempotency simulations pass;
- invalid transitions fail closed.

### Stage 3: Git and verification adapters

Implement worktree preparation, write policy, change capture, protected-repo fingerprinting, and deterministic verification.

Exit criteria:

- fixture tests prove original and reference repositories remain unchanged;
- unauthorized Bash mutation is detected and safely restored in a clean fixture;
- verification exit codes and output artifacts are correct.

### Stage 4: autonomous OMP adapter and run driver

Implement the highest-ranked confirmed OMP adapter and the managed out-of-process run driver.

Exit criteria:

- create a durable session;
- run more than one turn;
- restart the host process;
- resume the same logical session;
- receive a terminal lifecycle event;
- cancel a running turn;
- persist all required identifiers;
- no open TUI is required;
- the initiating OMP session can exit while the managed driver continues;
- a second driver cannot acquire the same run lease;
- a dead driver can be replaced without manual manifest editing.

### Stage 5: foreground adapter

Implement tested `live` or `handoff` foreground behavior.

Exit criteria:

- same-session nonce E2E passes;
- concurrent writer attempt fails closed;
- controller resumes after operator return;
- Warp automation is not required.

### Stage 6: automated implementation and verification loop

Wire approved-contract import, workspaces, implementer execution, automatic verification, and same-session repair.

Exit criteria:

- a seeded fixture defect is fixed without user interaction;
- a failing check returns to the same logical session;
- task advances only after required checks pass;
- process restart during the loop recovers.

### Stage 7: independent review loop

Add fresh reviewer sessions, structured review results, bounded fixes, and optional risk-triggered security lens.

Exit criteria:

- seeded semantic defect passes tests but is rejected by reviewer;
- implementer fixes it;
- verification reruns;
- a fresh reviewer passes it;
- reviewer cannot write product files.

### Stage 8: self-development validation

Implement candidate runtime isolation and the scenario pack.

Exit criteria:

- stable runtime evaluates candidate runtime;
- candidate cannot mutate stable runtime;
- candidate fixture run reaches `ready_for_acceptance` without an open TUI;
- candidate does not self-promote.

### Stage 9: bindings, migration, and cleanup

Actions:

- register TCSF commands and tools once;
- make old handoff/status commands thin aliases if needed;
- rewrite active skills;
- remove obsolete probe and task-runner entrypoints only after replacement tests pass;
- remove `V2` from active user-facing and agent-facing text;
- synchronize dotfiles source to active runtime through the existing mechanism;
- verify active runtime bytes or hashes match source before final smoke tests.

Exit criteria:

- one active TCSF extension;
- no duplicate command/tool registration;
- no active V2 terminology;
- loader and E2E checks pass from the active runtime.

## 23. Mandatory hypothesis cards

Persist each result under:

```text
<task-run>/reports/hypotheses/H-XX.json
```

Each result contains claim, prior evidence, exact commands or API calls, environment, observed output, verdict, selected fallback, and downstream consequences.

### H-01: OMP RPC supports durable multi-turn sessions

Claim:

A local OMP RPC process can create a file-backed session, run multiple turns, expose terminal lifecycle events, close, and resume the same logical session in a fresh process.

Experiment:

- use an isolated repo and session directory;
- start the installed OMP in RPC mode using documented arguments;
- send a first turn containing a unique nonce;
- wait for terminal event;
- persist returned session identity;
- stop the process;
- start a new process resuming that session;
- ask for the nonce and inspect history/session identity.

Success:

- both turns are present once;
- session identity maps to the same persisted history;
- terminal events are reliable;
- process restart does not require transcript copying.

Fallback:

1. public OMP SDK file-backed session manager;
2. repeated CLI JSON turns with explicit resume.

If all fail, autonomous same-session OMP execution is an architecture blocker.

### H-02: OMP RPC exposes enough lifecycle and cancellation data

Claim:

The installed protocol can distinguish terminal agent completion, tool activity, transport failure, and cancellation.

Experiment:

- run a normal short turn;
- run a tool-using turn;
- interrupt a deliberately long turn;
- kill the process unexpectedly;
- record events and exit behavior.

Success:

- controller can classify all four cases without parsing human prose.

Fallback:

- combine JSON event mode, process exit, timeout, and session inspection.

If terminal completion cannot be distinguished reliably, do not build the autonomous controller on that adapter.

### H-03: Same-session foreground handoff works

Claim:

A session created or controlled headlessly can be resumed interactively, then returned to autonomous control without transcript copying.

Experiment:

- complete one headless turn with a nonce;
- close controller transport and release lease;
- resume the session in a real interactive OMP client;
- add a second message;
- close or hand back;
- resume headlessly and verify both prior facts.

Success:

- one logical persisted session contains all turns;
- no concurrent writer exists;
- no duplicate or missing messages.

Fallback:

- use documented session-file or session-ID resume command after safe process stop;
- show exact command through `/tcsf_attach`.

A new summarized session is not an acceptable fallback.

### H-04: Current `ctx.newSession` can be isolated as an interactive adapter

Claim:

The installed public extension API can create a clean foreground implementer session with controlled cwd, workspace roots, bootstrap message, and a durable session reference.

Experiment:

- inspect public types first;
- run an isolated extension probe;
- capture actual session identity and cwd;
- verify clean transcript boundary;
- verify behavior on cancellation and bootstrap failure.

Success:

- all required behavior uses public APIs;
- the resulting session can be represented as `AgentSessionRef`.

Fallback:

- keep `ctx.newSession` only as a convenience for a fresh operator session;
- use normal OMP resume handoff for existing autonomous sessions.

TCSF core must not depend on H-04.

### H-05: Unexpected OMP UI requests can be handled or rejected

Claim:

An autonomous OMP worker will not wait forever on an invisible prompt.

Experiment:

- trigger a known approval or UI request in an isolated worker;
- observe RPC or SDK behavior;
- test configured unattended policy;
- test timeout and rejection path.

Success:

- request is bridged to TCSF, answered by deterministic policy, or rejected with a classified terminal result.

Fallback:

- prohibit UI-dependent tools in worker mode;
- route all material decisions through `tcsf_request_decision`;
- fail unexpected UI requests as protocol blockers.

### H-06: Candidate runtime can be isolated from stable runtime

Claim:

A fresh OMP process can load candidate TCSF code while using isolated task and session storage and without modifying active runtime files.

Experiment:

- fingerprint stable runtime and state;
- launch candidate with documented isolation controls;
- run loader diagnostics and a fixture workflow;
- compare fingerprints afterward.

Success:

- candidate code is actually loaded;
- stable files and stable session/task state are unchanged;
- candidate artifacts are confined to isolated paths.

Fallback:

1. explicit candidate extension path and isolated session dir;
2. temporary HOME plus explicit paths;
3. repository-local loader harness in a fresh process.

If none isolate the candidate, stop self-development implementation and request an architecture decision.

### H-07: OMP tool hooks can enforce session-bound write policy

Claim:

The installed extension API can identify the bound task/session and deny unauthorized `edit` or `write` calls before mutation.

Experiment:

- bind a fixture implementer session;
- attempt allowed and forbidden paths, including symlinks and traversal;
- inspect tool hook inputs and results.

Success:

- allowed worktree write succeeds;
- source/reference/traversal writes fail before mutation;
- session binding is unambiguous.

Fallback:

- retain post-turn Git and filesystem integrity enforcement as mandatory;
- disable direct edit/write tools that cannot be safely guarded in autonomous worker mode.

Even when H-07 passes, post-turn integrity checking remains required.

### H-08: Structured reviewer result is reliable

Claim:

A reviewer can submit one schema-validated result through a bound TCSF tool, and the controller can detect missing, duplicate, or malformed submissions.

Experiment:

- valid pass;
- valid fail with findings;
- no tool call;
- malformed call;
- duplicate calls.

Success:

- only one valid result is accepted;
- all invalid cases become protocol failures;
- reviewer final prose cannot override the structured verdict.

Fallback:

- parse final JSON against a strict schema and allow one repair turn.

If both fail repeatedly, automated semantic review is blocked.

### H-09: HERDR can provide live OMP foregrounding on this machine

Claim:

The installed HERDR can start, identify, wait for, inspect, and attach to an OMP agent while preserving session identity.

Experiment:

- detect binary and version;
- inspect documented local help and provider support;
- start an isolated OMP agent;
- prompt and wait;
- attach/focus;
- detach and resume automation;
- verify IDs and writer ownership.

Success:

- live attach works without transcript copying or uncontrolled concurrent input.

Fallback:

- do not install or patch HERDR in this task;
- use OMP handoff foregrounding.

H-09 failure is not a blocker for TCSF core.

### H-10: Legacy task runtime can coexist read-only during migration

Claim:

The new TCSF extension can register without corrupting or silently consuming old task manifests.

Experiment:

- load representative legacy manifests in fixture storage;
- start TCSF with both code paths present but only new command ownership;
- verify old tasks are reported as legacy and unchanged;
- verify no duplicate registrations.

Success:

- old state is untouched;
- new tasks use only TCSF storage;
- commands resolve to one implementation.

Fallback:

- disable the old extension entrypoint after preserving its files under history;
- provide an explicit one-task import command later, outside this scope.

### H-11: Managed run driver outlives the initiating OMP session

Claim:

A TCSF run can be started from an OMP command, continue in a managed local driver after that OMP session exits, and later be inspected or resumed without an orphaned duplicate controller.

Experiment:

- start a fixture run through the real command binding;
- record driver PID identity, start token, lease, and heartbeat;
- terminate the initiating OMP process or session;
- verify the fixture run advances;
- attempt to start a second driver and verify lease rejection;
- terminate the driver;
- start a replacement through `/tcsf_resume` and verify state reconciliation.

Success:

- the run continues after initiating UI exit;
- exactly one live driver owns the run;
- driver logs and heartbeat remain observable;
- replacement continues without duplicate stage effects.

Fallback:

1. host the run driver in a confirmed HERDR pane;
2. run the driver as an explicit foreground CLI command in a dedicated terminal while preserving all state and re-entry semantics.

The second fallback is acceptable for development but does not satisfy unattended default acceptance. If no managed driver can outlive the initiating OMP session, AC-04 fails.

## 24. Test requirements

### 24.1 Unit tests

Required coverage:

- all allowed and forbidden state transitions;
- optimistic revision and lease conflicts;
- event append and replay;
- retry counters by failure class;
- critical decision classification;
- task packet hash validation;
- path traversal and symlink protection;
- worktree planning by repo role;
- protected-repo fingerprints;
- verification exit-code handling;
- review result validation;
- adapter selection from probe results;
- wall-time and heartbeat expiry;
- cancellation;
- no direct transition to accepted or completed from an agent result.

### 24.2 Port contract tests

Every real and fake adapter implements the same contract suite.

Agent runtime contract:

- create;
- multi-turn;
- resume after close;
- terminal event;
- cancellation;
- transport failure;
- opaque serializable session reference.

Execution host contract:

- start and inspect;
- writer lease exclusivity;
- graceful and forced stop;
- foreground capability report;
- lost-host detection.

Artifact store contract:

- atomic write;
- revision conflict;
- crash-safe append;
- no path escape.

### 24.3 Mandatory real E2E scenarios

#### E2E-01: autonomous approved task

Start from an approved fixture contract with no interactive OMP session open.

Expected:

- worktree created;
- implementer changes code;
- verification passes;
- fresh reviewer passes;
- task reaches `ready_for_acceptance`;
- source checkout remains unchanged;
- the initiating OMP session may terminate after starting the run and the managed driver still reaches the result.

#### E2E-02: verification repair in same session

Seed a task where first implementation fails a deterministic test.

Expected:

- failure is sent to the same logical implementer session;
- session identity does not change;
- agent fixes the code;
- checks rerun and pass.

#### E2E-03: semantic review repair

Seed a defect that passes tests but violates the approved contract.

Expected:

- fresh reviewer returns a blocking structured finding;
- implementer fixes it in the same logical session;
- verification reruns;
- a new fresh reviewer passes.

#### E2E-04: critical decision pause and restart

Seed an approved contract conflict that requires observable behavior choice.

Expected:

- durable decision request with options and recommendation;
- task enters `waiting_for_decision`;
- controller process can exit;
- user resolves later;
- run resumes at recorded stage without repeating completed work.

#### E2E-05: worker crash recovery

Kill the autonomous OMP host after at least one persisted turn.

Expected:

- run detects lost host;
- new host resumes the same logical session;
- no duplicate prompt is applied;
- workflow continues.

#### E2E-06: foreground handoff

Use the nonce procedure from section 14.

Expected:

- same logical session before, during, and after handoff;
- concurrent controller prompt is denied while operator holds lease;
- controller can regain control.

#### E2E-07: unauthorized write

Attempt writes to original source, reference repo, path traversal, and symlink escape.

Expected:

- direct mutations are denied when possible;
- Bash mutation is detected;
- clean protected repo is restored safely;
- task does not continue as successful.

#### E2E-08: controller crash after verification

Terminate controller after checks finish but before next manifest update.

Expected:

- restart reconciles persisted verification evidence;
- checks are either safely reused after revalidation or rerun;
- state advances once.

#### E2E-09: candidate self-test

Modify a harmless TCSF behavior in a candidate worktree.

Expected:

- stable runtime launches isolated candidate;
- candidate scenario pack runs;
- stable runtime remains unchanged;
- final state is `ready_for_acceptance`, not completed or merged.

#### E2E-10: active terminology and registration

Expected:

- one active TCSF extension;
- active skill and agent files contain no `V2` product terminology;
- loader reports no duplicate commands or tools;
- historical docs are clearly non-normative.

### 24.4 Long-run simulation

A real twelve-hour model run is not required for every test. Prove the mechanics with accelerated clocks and process restarts:

- wall-time budget survives restart;
- heartbeat expiry works;
- bounded retry counters survive restart;
- waiting states do not consume active runtime loops;
- logs remain bounded and full outputs move to artifacts;
- no resource or process leak after many turns.

Then run at least one real unattended fixture workflow long enough to exercise multiple implementation, verification, and review turns.

## 25. Acceptance criteria

### AC-01: approved-contract boundary

TCSF can start from a frozen approved contract without invoking Cracker or asking the user to restate intent.

### AC-02: interface-neutral core

Core and workflow modules import no OMP, HERDR, Warp, Bun process, Git CLI, or filesystem-specific APIs. Those dependencies exist only in adapters and bindings.

### AC-03: durable foregroundable execution

Every production execution reports `live` or `handoff`, persists its logical session reference, and passes the foreground continuity E2E.

### AC-04: initiating UI independence

An approved fixture task reaches `ready_for_acceptance` without a pre-existing interactive worker session, and the OMP session that started the run may exit while the managed driver continues.

### AC-05: same logical session repair

Verification and review failures return to the same logical implementer session unless a classified irrecoverable session failure is recorded.

### AC-06: single-writer lease

Concurrent controller and operator writes to one session are prevented before input is sent.

### AC-07: controller recovery

A controller restart can resume an active run from durable state without manual state editing.

### AC-08: worker recovery

A lost host can resume a valid logical session in a replacement host.

### AC-09: deterministic verification

Required commands run in code with real cwd, exit code, bounded output, and durable full logs.

### AC-10: automatic verification trigger

The factory runs verification after terminal implementation turns. Completion does not depend on the model remembering `task_submit`.

### AC-11: independent review

A fresh read-only reviewer evaluates the actual diff and frozen contract through a schema-validated result.

### AC-12: bounded autonomous repair

Verification, review, and candidate failures use persisted finite repair counters and stop with evidence when exhausted.

### AC-13: critical-only human decisions

The factory does not ask about routine implementation mechanics. Critical semantic decisions produce durable structured requests.

### AC-14: external blocker distinction

Infrastructure and operator blockers are not misrepresented as product decisions.

### AC-15: Git-authoritative scope

Actual Git and filesystem changes, not agent claims, determine modified scope.

### AC-16: protected repositories

Original source and reference repositories remain unchanged in all successful E2Es.

### AC-17: adapter contract

Fake and selected OMP adapters pass the same runtime and host contract suites.

### AC-18: Warp independence

Factory correctness does not depend on Warp automation. Warp may be used as the human terminal only.

### AC-19: HERDR optionality

HERDR absence or failed probe does not break TCSF. A confirmed HERDR adapter may upgrade foreground capability to `live`.

### AC-20: stable-versus-candidate isolation

Stable TCSF controls and evaluates self-change candidates. Candidate code and state cannot replace or mutate the stable runtime during validation.

### AC-21: no self-promotion

Self-development stops at `ready_for_acceptance` and performs no merge, push, deploy, or active-runtime replacement.

### AC-22: one implementation per command

Human commands, model tools, tests, and future scheduler calls share application services. Compatibility aliases contain no lifecycle logic.

### AC-23: active terminology cleanup

Active skills, agents, commands, notifications, and normative docs use TCSF and contain no Task Factory V2 or role V2 language.

### AC-24: legacy safety

Legacy task state is not silently migrated, overwritten, or interpreted as a TCSF task.

### AC-25: evidence-backed report

Every acceptance result links to executed tests, probe results, event records, Git evidence, or runtime artifacts.

## 26. Explicit non-goals

Do not implement these in this change:

- a generic DAG or workflow language;
- a large taxonomy of specialist agents;
- automatic push, merge, MR creation, deploy, or publication;
- a web dashboard;
- a database when atomic files and JSONL satisfy the tested requirements;
- distributed execution across machines;
- more than one concurrent active writer task by default;
- speculative Warp automation through undocumented APIs;
- automatic HERDR installation or modification;
- arbitrary migration of all legacy tasks;
- model-quality benchmarking;
- cost or token budgets beyond telemetry and finite structural limits;
- autonomous product grokking without a human decision authority;
- hot-reloading candidate factory code into the stable controller.

## 27. Agent working rules

1. Read actual installed public APIs before coding against them.
2. Prefer public SDK, CLI, RPC, and extension contracts. Do not import internals merely to avoid a probe failure.
3. Do not hide a rejected hypothesis behind a type cast or silent compatibility shim.
4. Do not use `as unknown as` to claim an API exists.
5. Do not claim runtime behavior from unit tests alone.
6. Run all destructive or session experiments in isolated temporary repos and storage roots.
7. Never use `git reset --hard` against a repository that may contain pre-existing user work.
8. Do not ask the user about a technical choice when this document defines a fallback.
9. Ask only when the critical decision policy requires it or no safe fallback remains.
10. Do not push or merge.
11. Keep unrelated dotfiles and configuration unchanged.
12. Verify source-to-active-runtime synchronization before active runtime tests.
13. Record exact versions and commands in probe reports.
14. Keep full logs in artifacts and concise summaries in the TUI.
15. If an implementation stage exposes a flaw in this architecture, stop only that architectural change. Persist evidence, options, recommendation, and impact. Continue independent work that remains safe.

## 28. Final implementation report

Return exactly these sections:

```text
## Implemented architecture
- modules, ports, adapters, commands, and workflow behavior

## Hypotheses
- H-01 through H-11 with CONFIRMED, REJECTED_WITH_FALLBACK, or BLOCKED
- evidence paths
- selected adapter paths

## Removed or superseded
- old task runtime behavior
- old probes
- duplicate commands and tools
- active V2 terminology

## Verification
- baseline tests
- unit tests
- adapter contract tests
- loader tests
- real OMP E2Es
- foreground handoff result
- self-development candidate result

## Acceptance criteria
- AC-01 through AC-25 with PASS or FAIL
- concrete evidence for every PASS

## Deviations
- deliberate deviations only
- reason
- effect on invariants and acceptance

## Human decisions required
- only open critical decisions or operator blockers
- options and recommendation

## Remaining risks
- observed, evidence-backed risks only
```

Do not call the implementation complete while any mandatory acceptance criterion is unexecuted or failed. A partially working system may be reported honestly, but it must not replace failed evidence with confident prose.

## 29. Definition of done

A user can provide an approved implementation contract, start TCSF from OMP, close or ignore the TUI, and later return to a durable result.

During the run, TCSF can implement, run deterministic checks, repair failures in the same logical session, obtain an independent review, repair review findings, survive controller or worker restarts, and test candidate factory changes in isolation.

The user is interrupted only for a critical semantic decision, an irreversible action, or an external blocker with no safe recovery. Any running worker can be brought into the foreground through a tested live attach or same-session handoff.

The final product state is `ready_for_acceptance`. TCSF never grades and promotes its own candidate without an external stable evaluator and explicit acceptance.

## 30. Research references

The implementation agent should prefer installed local documentation and source when exact behavior differs from these references.

- SSSF repository: https://github.com/disler/super-simple-software-factory
- OMP CLI reference: https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md
- OMP SDK reference: https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md
- OMP RPC reference: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- HERDR agents: https://herdr.dev/docs/agents/
- HERDR agent automation: https://herdr.dev/docs/agent-automation/
- HERDR session state: https://herdr.dev/docs/session-state/
