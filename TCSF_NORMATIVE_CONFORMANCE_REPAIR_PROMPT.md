# TCSF normative conformance and runtime repair directive

Read completely before editing:

1. `TCSF_IMPLEMENTATION_SPEC.md`
2. `TCSF_CORRECTIVE_VALIDATION_PROMPT.md`
3. the current TCSF source under `dot_omp/private_agent/extensions/tcsf/`
4. the current acceptance root under `~/.omp/tcsf-acceptance-20260830/`
5. this directive

The normative implementation specification is the only authority for hypothesis, E2E, candidate-scenario, and acceptance-criterion meanings. A later prompt may choose execution order, but it may not redefine an ID. When any prompt conflicts with the normative specification, follow the normative specification and record the conflict.

The current implementation is a valuable prototype. Preserve it. Do not restart from scratch. A real autonomous happy path has been demonstrated, but the current conformance report is invalid because component probes were labeled with normative E2E and candidate IDs that test different behavior.

This is an implementation and conformance pass. Do not stop after producing another truthful FAIL report. Continue repairing and executing the exact scenarios until all independently runnable work is exhausted or an explicit escalation condition at the end of this directive is met.

## Work already authorized

Do not ask the user for permission to:

- edit TCSF source, tests, fixtures, adapters, drivers, report validators, and evidence collectors;
- run real OMP RPC fixtures;
- kill and replace fixture worker or controller processes;
- perform interactive handoff experiments against isolated fixture sessions;
- execute E2E-01 through E2E-10 and C-01 through C-10;
- run adversarial reviewer, filesystem, Git, lease, timeout, cancellation, and restart tests;
- create an immutable bootstrap parent because no previously accepted TCSF parent exists;
- use accelerated clocks and controlled restarts for long-run mechanics;
- select safe local models and timeouts for fixtures;
- replace a failed approach with a fallback already allowed by the specification.

Do not commit, push, merge, deploy, promote, or overwrite a known accepted runtime.

## Phase 0: preserve the current milestone

Before changing source:

1. Snapshot source, active runtime, current acceptance reports, and all untracked files.
2. Record source and active tree hashes, not only `index.ts` hashes.
3. Preserve the successful real E2E-01 evidence as historical milestone evidence.
4. Do not rewrite or delete old evidence. Mark superseded reports as non-current.
5. Record the exact rollback command.

The current milestone may be described as:

```text
real autonomous happy-path prototype demonstrated
normative conformance incomplete
```

It must not be described as ten normative E2E scenarios passing.

## Phase 1: repair the conformance taxonomy before more testing

### 1.1 Rename the existing component probes

The current scripts named `e2e-02.ts` through `e2e-10.ts` do not implement the normative scenarios with those IDs. Preserve their code and evidence, but rename them to honest probe IDs. Suggested names:

```text
P-REVIEW-PROTOCOL-REPAIR
P-CANDIDATE-LOADER
P-DECISION-API-PERSISTENCE
P-DRIVER-PROCESS-REPLACEMENT
P-DRIVER-OWNERSHIP
P-LOCAL-WRITER-LEASE
P-WORKTREE-UNAUTHORIZED-RESTORE
P-REFERENCE-REPO-PASSIVE-CHECK
P-PROCESS-TREE-CANCELLATION
```

A probe may support an acceptance criterion, but it may not claim a normative E2E ID unless it performs the exact scenario.

### 1.2 Create one canonical conformance catalog

Create machine-readable definitions for:

- H-01 through H-11;
- E2E-01 through E2E-10;
- C-01 through C-10;
- AC-01 through AC-25.

Each definition must include:

```text
id
title
normative definition hash
required actors
required process boundaries
required preconditions
required observations
required evidence files
linked hypotheses and ACs
```

The validator must reject:

- wrong title or definition hash;
- an E2E implemented by a fake adapter when the definition requires real OMP;
- missing required process boundary, such as controller restart or initiating UI exit;
- a passive repository check when the scenario requires an attempted mutation;
- candidate evidence produced without an immutable parent;
- stale evidence generated before the tested source revision;
- a report that contradicts its hypothesis cards;
- a PASS whose runner source does not match the canonical scenario ID.

### 1.3 Generate reports from evidence

Do not hand-edit `reports/final/acceptance.json`.

Implement a deterministic report generator that:

1. reads the canonical catalog;
2. validates every referenced file and its content;
3. validates source tree hash and configuration recorded by each run;
4. verifies that compile and test logs were generated after the latest source change included in the report;
5. checks that hypothesis cards and the final report agree;
6. distinguishes `PASS`, `FAIL`, `NOT_RUN`, and `BLOCKED_BY_DEPENDENCY`;
7. fails AC-25 on any contradiction, stale log, relabeled probe, or unsupported PASS.

The current contradictions must become regression tests:

- H-01 card says `CONFIRMED` while the final report says `BLOCKED`;
- H-08 card says `BLOCKED` while the final report says `CONFIRMED`;
- the final report says 17 tests and 41 expectations while its command artifact records 16 and 40;
- the old long-run report says mechanics were not executed while the final report calls two happy paths a long-run PASS.

## Phase 2: fix the runtime defects exposed by the real happy path

Do not proceed to repair and recovery E2Es until these foundational defects have regression tests.

### 2.1 Durable state must not be hidden behind stale process-local caches

The real E2E-01 evidence shows that the initiating factory returned a cached revision-0 run in `validate/running` while the managed driver had persisted revision 6 in `ready_for_acceptance/terminal`.

Required changes:

- do not cache durable run, execution, workspace, decision, or driver state indefinitely;
- reload durable state or validate cache entries against revision or content hash;
- `getStatus`, `cancelRun`, foreground operations, decision resolution, and resume must observe another process's latest state;
- add a cross-process test where one factory advances a run and another factory observes the new revision without restart.

In-memory transport handles may remain process-local. Durable facts may not.

### 2.2 Add compare-and-swap and lease validation for runs and executions

Task revision CAS is not enough.

Required behavior:

- every run update supplies an expected revision;
- stale writers are rejected;
- the active controller or driver token is validated before every state transition;
- the run lease is renewable and persisted;
- takeover after expiry is explicit and atomic;
- execution state updates also reject stale revisions;
- two controllers cannot advance one stage concurrently;
- crash after an external side effect and before state save is reconciled exactly once.

Do not use an in-memory map as the authority for ownership.

### 2.3 Finish the run-driver lifecycle

Required behavior:

- atomic claim before spawn;
- no orphan if spawn succeeds and manifest persistence fails;
- manifest identifies PID, start token, process start identity, current state, heartbeat, and final exit;
- heartbeat and the main loop cannot race and overwrite one another;
- normal and failed exit write `stopped` or `failed` and release the claim;
- `inspect` validates heartbeat, token, and process identity, not only PID existence;
- `stop` terminates the process tree, waits, records final state, and releases ownership;
- a replacement driver rejects stale predecessors and reconciles durable stage effects.

The successful happy-path evidence currently leaves `driver.json` in `running`, the execution in `running`, and the run lease unreleased after terminal completion. Fix and test all three.

### 2.4 Correct retry semantics

`maxImplementationRetries` means retries after the initial attempt unless the normative schema explicitly says otherwise.

Required behavior:

- one initial attempt plus N permitted retries;
- verification and review repair loops can actually return to the same implementer session;
- retry counters persist across controller and driver restart;
- task and run counters have one documented meaning;
- task policy, not a hidden global default, controls all retry limits;
- review and candidate round counters are incremented and persisted.

Add boundary tests for zero retries, one retry, and exhaustion.

### 2.5 Make RPC lifecycle suitable for long autonomous turns

Required changes:

- turn timeout and silence timeout are configurable by task, role, and model profile;
- defaults must tolerate known slow first-token latency and long coding turns;
- a heartbeat or explicit lifecycle frame resets silence only when it proves transport activity;
- drain and persist stderr while the process runs;
- ready, command, turn, interrupt, and close timeouts clean up the process and maps;
- timeout uses `SIGTERM`, grace period, then `SIGKILL` on the process tree;
- unexpected UI requests receive an explicit rejection or bounded failure and cannot leave an orphan process;
- only one pending turn per transport unless frame routing is keyed and proven correct;
- raw protocol evidence is written in order, errors are surfaced, and the final partial line is handled;
- cancellation waits for and proves terminal cancellation or classifies transport failure;
- session metadata records effective model, provider, policy, flags, workspace roots, and read-only roots.

Do not claim child skill or extension enforcement while launching with `--no-extensions --no-skills --no-rules`. If that isolation remains the design, make host, Git, and filesystem enforcement sufficient by itself and document the trust boundary.

### 2.6 Durable decisions must originate from real workflow findings

When a reviewer returns `decision_required`, the factory must create and publish a complete `DecisionRequest` before entering `waiting_for_decision`.

The request must contain:

- concrete question;
- evidence;
- options;
- recommendation;
- consequence of each option;
- exact resume stage;
- task, run, review, and session identities.

A test that manually calls `requestDecision` does not prove this path.

After restart:

- the request is loaded from durable state;
- malformed or conflicting artifacts fail closed;
- waiting does not spin a driver loop;
- resolution is single-use and idempotent;
- completed stages are not repeated.

### 2.7 Implement worker recovery rather than generic driver replacement

A lost OMP worker must not immediately fail the product run as a generic protocol error.

Required behavior:

- classify worker process death and transport loss separately;
- persist prompt intent or turn identity before send;
- distinguish unsent, sent-unacknowledged, terminal, and persisted-result states;
- avoid applying one prompt twice;
- start a replacement OMP host;
- resume the same persisted logical session;
- continue under the infrastructure retry budget;
- retain raw evidence for the old and new processes.

A fixture that replaces `LocalRunDriverHost` without an OMP session is only a component probe.

### 2.8 Complete foreground handoff as a state machine

Required protocol:

1. Controller owns a durable writer lease.
2. A continuity nonce is inserted into the actual logical session history before handoff.
3. Run enters `waiting_for_operator` or another explicit handoff stage.
4. Controller stops or detaches its writer and durably releases its lease.
5. Operator acquires the lease and resumes the same persisted OMP session.
6. Wrong session, wrong nonce, expired nonce, replayed nonce, and concurrent controller prompt are rejected.
7. Lease release works from a new process and does not depend on an in-memory map.
8. Corrupt lease JSON fails closed. Never delete it and grant ownership.
9. Leases renew during long turns and handoffs.
10. On return, the nonce is consumed, the operator lease is released, the controller reacquires ownership, and the run resumes.

A same-process lease exclusivity test is not foreground continuity proof.

### 2.9 Complete repository and filesystem safety

Fix and test:

- segment-aware scope matching, so `src/**` does not allow `src2/file`;
- correct porcelain `-z` rename and copy parsing;
- recursive safe removal of agent-created directories;
- canonical source and reference fingerprints checked after every writer turn;
- detection of committed mutations, not only dirty status;
- untracked file content fingerprints;
- Bash mutations from child OMP processes;
- path traversal and symlink escapes;
- safe restoration without deleting pre-existing user work;
- fail-closed behavior when safe restoration cannot be proven;
- stale task-lock recovery and crash-safe event append.

A passive reference repository that remains clean without an attempted write does not prove protection.

### 2.10 Make verification cancellation and logs bounded

Required behavior:

- explicitly record whether a timeout fired;
- terminate the full process tree;
- escalate from graceful to forced termination;
- do not infer timeout only from exit code;
- do not wait forever for ignored termination;
- stream full stdout and stderr to artifacts;
- retain only bounded tails in memory and manifests;
- prove grandchildren do not survive.

### 2.11 Make reviewer evidence truthful

Keep strict final JSON output and one repair turn in the same reviewer session.

Also:

- reject parsing when the turn itself failed;
- pin and record the effective reviewer model and provider;
- record distinct reviewer session IDs per review round;
- run at least twenty adversarial cases, including malformed JSON, extra prose, stale result, duplicate result, wrong stage, wrong run, wrong session, implementer-shaped output, unrelated reviewer, repair success, repair exhaustion, cancellation, transport death, and contradictory prose;
- make documentation match the actual trust model. If the result is simply strict final output from a factory-created no-tools session, say that. Do not claim a separate bound submission channel.

H-08 remains `BLOCKED` until the real exact-schema probe and the complete adversarial suite pass.

### 2.12 Build real stable-parent candidate isolation

The candidate loader currently builds a bundle but loads the source path. Fix that first.

Required isolation:

- immutable parent evaluator bundle;
- separate candidate bundle;
- separate HOME or equivalent OMP root;
- separate TCSF_HOME, sessions, configuration, artifacts, repositories, and worktrees;
- no access to parent manifests or result files except a narrow parent-owned result channel;
- parent tree hash and parent state fingerprint before and after;
- hashes cover the full tree and state, not only `index.ts`;
- candidate cannot copy itself into active runtime or grade itself;
- parent validates events, Git state, process exits, schemas, and invariants.

The factory's self-change path must invoke the actual candidate scenario pack or an equivalent parent-owned validation plan. A loader smoke alone cannot move a self-change to `ready_for_acceptance`.

## Phase 3: execute the exact normative E2E scenarios

Use these definitions exactly. Do not reuse an ID for another test.

### E2E-01: autonomous approved task

- no pre-existing interactive worker session;
- managed driver starts;
- initiating OMP or equivalent initiating controller process exits after launch;
- driver continues independently;
- real implementer changes the fixture;
- deterministic verification passes;
- fresh real reviewer passes exact schema;
- source checkout remains unchanged;
- task reaches `ready_for_acceptance`;
- execution, driver, leases, and processes reach coherent terminal state.

The current happy path is supporting evidence, but rerun after cache and terminal-state repairs. Explicitly kill the initiating process rather than keeping a polling factory alive.

### E2E-02: deterministic verification repair in the same implementer session

Seed an initial implementation that fails a deterministic test.

Prove:

- first verification fails;
- failure evidence is sent to the same logical implementer session;
- session ID and session file are unchanged;
- turn sequence increases;
- implementation is repaired;
- verification reruns and passes;
- no duplicate initial prompt;
- retry counters persist correctly.

### E2E-03: semantic review repair

Seed a defect that passes deterministic checks but violates the approved contract.

Prove:

- reviewer session A returns a blocking exact-schema finding;
- same implementer logical session repairs it;
- deterministic verification reruns;
- fresh reviewer session B differs from A and passes;
- review limits and counters persist.

### E2E-04: critical decision pause and restart

Cause a real reviewer or workflow conflict that requires a human choice.

Prove:

- complete durable decision request is created automatically;
- task enters `waiting_for_decision`;
- driver exits rather than spinning;
- controller process terminates;
- a new process resolves the decision later;
- a replacement driver resumes from the recorded stage;
- completed implementation, verification, and review effects are not repeated.

### E2E-05: OMP worker crash recovery

After at least one persisted implementer turn, kill the OMP worker process.

Prove:

- lost host is detected;
- infrastructure retry is recorded;
- replacement OMP process resumes the same session file and session ID;
- the same prompt is not applied twice;
- workflow continues to a valid later stage.

### E2E-06: same-session foreground handoff

Use a real isolated OMP session and the complete handoff state machine.

Prove:

- same logical session before, during, and after;
- nonce was in pre-handoff session history;
- operator turn observes it;
- concurrent controller prompt is denied before send;
- wrong nonce and replay fail;
- restart during handoff is safe;
- controller reacquires the lease and continues.

HERDR is optional. A correct OMP handoff is sufficient.

### E2E-07: unauthorized write defenses

From clean fixtures, attempt all of:

- direct edit or write outside allowed scope;
- Bash mutation of original source checkout;
- Bash mutation of reference repository;
- path traversal;
- symlink escape;
- committed mutation that leaves Git status clean;
- mutation of an untracked file's contents.

Prove denial or post-turn detection, safe restoration where possible, preserved pre-existing user work, and failure of the task rather than continued success.

### E2E-08: controller crash after verification

Terminate the controller after verification evidence is complete but before the next run-state update.

Prove:

- replacement detects the incomplete transition;
- evidence is revalidated or verification reruns safely;
- state advances exactly once;
- no duplicate reviewer or repair turn;
- durable event identity exposes the reconciliation.

### E2E-09: isolated candidate self-test

Create a harmless N+1 TCSF candidate change.

Prove:

- immutable bootstrap parent launches isolated candidate;
- candidate runs required fixture scenarios;
- parent evaluates evidence without trusting candidate prose;
- stable source, active runtime, parent state, and parent evidence remain byte-identical;
- candidate ends only at `ready_for_acceptance` and cannot promote itself.

### E2E-10: registration and terminology integrity

Prove in a fresh loader process:

- one active TCSF extension registration;
- every expected TCSF command and tool exactly once;
- no active legacy lifecycle aliases;
- no active `V2` product terminology in skills, agents, source, bindings, or normative docs;
- legacy material exists only under clearly non-normative history;
- representative legacy manifests remain byte-identical and are not interpreted as TCSF state.

## Phase 4: execute the exact candidate pack

The immutable parent runs and grades:

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

Do not map multiple candidate IDs to the same loader script. Do not reuse component probes as candidate PASS unless they execute inside the candidate isolation boundary and satisfy the exact scenario.

## Phase 5: long-run mechanics

A literal twelve-hour test is not required for this conformance pass.

Use accelerated clocks and controlled restarts to prove:

- twelve-hour wall-time budget survives restart;
- heartbeat expiry detects lost driver and worker;
- retry counters survive restart and stay bounded;
- waiting states do not keep an active loop spinning;
- logs remain bounded while full streams are stored in artifacts;
- leases expire and renew correctly;
- stale processes cannot regain ownership;
- cancellation leaves no worker, child, descriptor, claim, lease, or worktree leak;
- repeated turns do not grow process-local state without bound.

Then run at least one real unattended fixture with multiple implementation turns, at least one repair, verification rerun, and two review rounds. Kill the initiating process after launch.

Running the same happy path twice is a repeatability probe, not the long-run mechanics scenario.

## Phase 6: final verification order

After the final source edit:

1. run TypeScript compile;
2. run unit tests;
3. run adapter contract suites;
4. run all component probes under their honest IDs;
5. run H-01 through H-11 experiments;
6. run E2E-01 through E2E-10;
7. run C-01 through C-10 under the immutable parent;
8. run long-run mechanics;
9. run active loader only after isolated source and candidate validation pass;
10. run a fresh independent read-only audit;
11. generate the final machine-readable report from the validator.

Record source tree hash, active tree hash, effective models, OMP version, Bun version, flags, environment roots, and timestamps. The final compile and test artifacts must be newer than every included source file.

Do not synchronize new bytes into active runtime merely to make parity pass. If active verification is needed, snapshot first, apply only after isolated success, run loader checks, and retain rollback evidence. This is still not promotion.

## Final report rules

The report must state separately:

```text
implementation status
hypothesis status
component-probe status
normative E2E status
candidate-pack status
long-run-mechanics status
acceptance status
```

A useful component probe may be `PASS` while its linked normative E2E remains `NOT_RUN` or `FAIL`.

Do not use `PARTIAL` as a final acceptance verdict. Do not convert `NOT_RUN` to `FAIL` or vice versa. Do not claim AC-25 unless the report validator proves internal consistency and evidence completeness.

## Escalation rules

Stop for the user only when every documented approach and safe fallback for the same required capability has been executed and failed, and continuing requires one of:

- destructive or irreversible action outside isolated fixtures;
- missing credentials or unavailable external service;
- a change to the approved product contract;
- commit, push, merge, deployment, promotion, or replacement of a known accepted runtime;
- a real security tradeoff for which no approved option satisfies the contract.

A failed test, long test, more required code, missing E2E harness, model-format repair, fixture creation, process restart, or candidate isolation work is not a human decision.

When escalating, provide exact failed experiments, evidence paths, attempted fallbacks, at least two choices, consequences, and a recommendation.
