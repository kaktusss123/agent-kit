# TCSF deterministic completion directive

## Status and authority

Read these inputs completely before editing:

1. `TCSF_IMPLEMENTATION_SPEC.md`
2. the current TCSF source
3. the latest acceptance root
4. this directive

The implementation specification remains the sole authority for H, E2E, C, and AC meanings. This directive selects implementation methods and execution order. It does not redefine any normative identifier.

Preserve the current implementation. Do not restart from scratch.

The current checkpoint has useful runtime improvements and a credible autonomous happy path. It is not accepted as a recoverable, foregroundable, self-testing factory.

The following claimed results are not accepted until the corrected scenarios below pass:

- E2E-05, because the current runner kills the run driver, not the autonomous OMP worker host.
- E2E-06, because the current runner does not launch an operator OMP process or perform an operator turn in the same session.
- E2E-08, because the current runner kills an idle initiating process while the managed driver continues. It does not kill the active controller between verification persistence and the next state transition.
- E2E-10, because the current runner primarily inspects the source tree and candidate loader, not the complete active runtime registration and guidance set.
- C-01 and C-02, because the current candidate process does not have fully isolated HOME, TCSF_HOME, config, state, sessions, and repositories, and C-02 partly parses source rather than validating the loaded registry.
- long-run, because the current runner executes E2E-01 twice. Repeatability is not the required restart, expiry, repair, review, bounded-log, and leak simulation.

Do not delete their evidence. Reclassify it as provisional or component evidence.

## Approved architecture decision

No human decision is required for the candidate API.

C-03 through C-10 are mandatory. Loader-only validation is not an accepted final scope.

Extend `CandidateRuntimePort`, but do not expose an OMP-specific low-level command or tool driving API to the factory core. Add high-level, replaceable operations:

```ts
interface CandidateRuntimePort {
  inspectCandidate(input: CandidateInspectionInput): Promise<CandidateInspectionResult>;
  executeScenario(input: CandidateScenarioInput): Promise<CandidateScenarioResult>;
}
```

The exact names may differ, but the split is required.

`inspectCandidate` proves loading and registry properties.

`executeScenario` asks an isolated candidate process to run one stable-parent-owned scenario manifest and return structured evidence. The factory core must not know slash-command syntax, OMP pane semantics, or tool invocation syntax.

The stable parent owns:

- scenario definitions;
- fixture creation;
- immutable parent fingerprints;
- timeouts and cancellation;
- acceptance predicates;
- final verdicts.

The candidate owns only candidate execution. It cannot accept, promote, merge, push, deploy, or mutate the parent runtime.

## Stage 0. Preserve and bind the latest evidence

The reported latest final bundle currently lives under `/tmp/tcsf-final`. `/tmp` is not durable acceptance storage.

Before more edits:

1. Copy the complete latest bundle into a new immutable timestamped directory under the durable acceptance root.
2. Preserve the original files and timestamps.
3. Record a manifest containing every relative path, size, and SHA-256.
4. Record the current source tree hash and active runtime tree hash.
5. Record the exact source revision or untracked-source snapshot used by every executed scenario.
6. Do not attach a current source hash to old evidence after execution.
7. Keep the previous uploaded acceptance root as historical evidence. Do not overwrite it.

If the `/tmp/tcsf-final` directory no longer exists, record that fact. Do not reconstruct claimed raw evidence from the prose report.

## Stage 1. Separate architecture conformance from model quality

The current E2E-02, E2E-03, E2E-04, and E2E-07 runners rely on a live model choosing a specific imperfect or adversarial behavior. This makes acceptance stochastic.

TCSF conformance must not depend on waiting until a model happens to fail in the desired way.

Create two distinct test layers.

### 1.1 Deterministic normative scenarios

Normative scenarios must deterministically induce the required state transition. They may use test-only fault injection at a port boundary, but they must still exercise the real factory state machine, durable artifacts, process boundaries, and selected production adapters relevant to the scenario.

Prefer process-backed deterministic test adapters over in-memory fakes when the scenario requires a fresh actor or process boundary.

Examples:

- verification fault injection occurs in a test verification adapter or decorator, not in a model-visible sentinel file;
- semantic reviewer rejection comes from a fresh process-backed deterministic reviewer that emits the exact schema;
- a decision request comes from a deterministic reviewer result or an explicit bound decision channel;
- unauthorized mutations are attempted by a deterministic adversarial execution fixture, not by hoping an implementer model follows a malicious prompt.

A real OMP implementer boundary should remain where the property under test concerns OMP session continuity. A deterministic reviewer adapter is acceptable for testing factory repair and decision orchestration. OMP reviewer reliability remains a separate H-08 and live capability probe.

### 1.2 Live-model capability probes

Keep live-model runs, but label them as capability or quality probes. They answer questions such as:

- does the selected reviewer usually detect a semantic defect;
- does the selected implementer follow repair evidence;
- does the selected provider return the strict schema.

A live-model capability failure must not be confused with a broken state machine. It may affect the selected production model profile, but it must not make deterministic architecture tests flaky.

Do not retry a normative scenario until a model happens to produce the desired answer.

## Stage 2. Repair remaining P0 runtime invariants

Complete these repairs before accepting recovery scenarios.

### 2.1 Renew ownership during long turns

The run lease currently lasts 60 seconds while a turn may last 120 seconds or longer. The writer lease may also outlive its safe renewal window.

During every active model turn:

- renew run ownership before expiry;
- renew the writer lease before expiry;
- persist heartbeat evidence;
- stop renewal in `finally`;
- fail closed if renewal loses ownership;
- interrupt the turn if ownership is lost;
- prevent another controller from taking over while the original live turn still owns valid process identity.

Use either a separate CAS lease artifact or a proven revision-safe renewal protocol. Do not let lease renewal race with stage transitions.

Add focused tests with an accelerated clock where the turn exceeds both original lease TTLs and a second controller remains denied.

### 2.2 Implement actual OMP worker recovery

Transport loss is not a semantic implementation failure.

Add a classified worker-loss path:

- persist turn intent before dispatch;
- persist dispatch acknowledgement immediately after the prompt is written;
- persist terminal completion separately;
- on OMP process death, inspect the durable session and turn state;
- launch a replacement OMP host;
- resume the same logical session;
- reconcile whether the prompt was accepted before deciding to resend;
- never apply the same logical prompt twice;
- continue the run if recovery succeeds;
- fail with exact evidence only after bounded recovery is exhausted.

The logical turn ID must be idempotent and based on execution ID, monotonic sequence, and prompt content hash. A uniqueness check over filenames is not proof of non-duplication.

### 2.3 Fix driver split-brain takeover

An alive driver with a stale heartbeat must not be silently replaced while it still runs.

Persist and validate:

- PID;
- process start token or equivalent identity;
- claim generation;
- controller ID;
- lease token;
- last heartbeat.

For an alive but stale driver, first reconcile or terminate the old driver. Only then issue a new claim. A dead PID may be taken over immediately after identity validation.

### 2.4 Do not suppress takeover release failures

`resumeRun` must not ignore arbitrary writer-lease release errors.

Only a proven already-released or superseded lease may be treated idempotently. Corrupt JSON, token mismatch, generation mismatch, and unknown ownership must stop takeover and require deterministic reconciliation.

### 2.5 Complete the OMP extension UI protocol

OMP RPC extension UI is a request-response protocol.

For every `extension_ui_request`:

- send the matching `extension_ui_response` using the request ID;
- acknowledge harmless methods with a deterministic success response;
- reject unsupported interactive methods with an explicit cancelled or error response;
- persist both request and response;
- apply a bounded timeout;
- never only ignore a request.

Add a protocol test proving that a pending extension request cannot deadlock a turn.

### 2.6 Make timeouts model and stage aware

Remove the fixed assumption that 45 seconds without a frame means a dead worker.

Timeout policy must depend on:

- model profile;
- role;
- stage;
- whether the process is alive;
- whether startup or agent activity has begun;
- task wall-time policy.

Keep an overall turn deadline and process-health checks. A slow time-to-first-token must not be classified as a dead worker merely because no model frame arrived within a globally fixed interval.

## Stage 3. Correct the exact E2E scenarios

### E2E-01

Preserve the improved controller-exit runner. Rerun it from the final source and save complete durable evidence.

The deterministic oracle must check at least:

- real frozen contract hashes and copied bytes;
- controller OS exit observed by the parent;
- observer starts before controller exit;
- observer sees a nonterminal state after controller exit;
- driver progress occurs after controller exit;
- target file content is exact;
- verification command exits with the expected code;
- fresh reviewer result uses the schema;
- source checkout remains unchanged;
- execution and driver records are coherent at terminal state;
- no OMP, driver, verification, or fixture processes remain.

### E2E-02

Do not expose a fail-once sentinel inside the model-visible writable scope.

Use a harness-owned deterministic injection. One acceptable method is:

1. allow the first real OMP implementation turn to finish;
2. inject a known defect through a test workspace decorator before the first verification;
3. run deterministic verification and record the failure;
4. send the failure to the same implementer session;
5. require a second completed turn in the same session;
6. require the agent to restore the expected file;
7. rerun verification and pass.

The oracle must compare the same session ID, monotonic turn sequences, prompt hashes, and actual file state.

### E2E-03

Use a deterministic fresh process-backed reviewer for the normative repair path.

Required sequence:

1. first implementation and verification pass;
2. a known semantic defect exists;
3. reviewer process A returns a blocking structured finding;
4. the same implementer session receives it and repairs the file;
5. verification reruns;
6. fresh reviewer process B, with a different session or process identity, passes;
7. exactly one semantic repair is counted.

Run the live OMP reviewer against the same fixture as a separate capability probe. Do not use its stochastic verdict as the normative oracle.

### E2E-04

Use a deterministic reviewer decision result or a bound test decision channel.

Required sequence:

- durable request contains evidence, options, recommendation, consequence of delay, and resume stage;
- task reaches `waiting_for_decision`;
- managed driver performs no active busy loop while waiting;
- the original controller and driver may exit;
- a new process loads the request by ID;
- one resolution is accepted;
- a conflicting second resolution is rejected;
- run resumes from the recorded stage without repeating completed work;
- task reaches `ready_for_acceptance`.

### E2E-05

Kill the actual OMP worker host PID, not the run driver PID.

Wait until at least one turn intent and dispatch acknowledgement are durable, then kill the OMP process before a terminal event.

Prove:

- lost worker detection;
- replacement OMP PID and transport identity;
- same logical session ID and session file;
- no duplicate logical prompt;
- bounded recovery counter;
- continued workflow;
- no orphan old worker;
- source checkout unchanged.

### E2E-06

Perform a real same-session operator handoff.

The current local lease transfer test is only a component probe.

Required sequence:

1. create an active implementer session and record its session ID, session file, message count, and host PID;
2. pause the controller and transfer the writer lease atomically;
3. launch a separate operator OMP process against the exact same session file;
4. make an operator turn that is visible in that session history;
5. prove a concurrent controller prompt is denied before input is sent;
6. stop the operator process;
7. return control with a single-use nonce tied to the pre-handoff session history;
8. reacquire controller ownership;
9. resume the same session and continue;
10. prove session ID, history continuity, and message count progression across all three phases.

The nonce must not be accepted merely because it was copied from handoff instructions. It must be bound to the existing session history and consumed once.

A PTY-backed operator process or a second controlled OMP client is acceptable. The evidence must identify the operator process and operator turn.

### E2E-07

Do not rely on the implementer model voluntarily attempting forbidden writes.

First implement an enforceable production safety mechanism at `ExecutionHost` or an equivalent policy boundary. A prompt is not enforcement.

Probe the preferred local sandbox available on the target macOS environment. If that cannot enforce the approved write roots, use the approved isolated-host fallback. Do not run real repositories without an enforceable or fail-closed boundary.

The deterministic adversarial fixture must attempt through the same worker containment boundary:

- allowed worktree write;
- original checkout write;
- reference repository write;
- `..` traversal;
- symlink escape;
- staged unauthorized write;
- committed unauthorized write;
- nested untracked directory;
- Bash child and grandchild process writes.

Prove denial where possible, detection, safe restoration of fixture repositories, unchanged outside canaries, task failure, and no continuation to acceptance.

### E2E-08

Add a test-only failpoint exactly after verification evidence is durably persisted and before the next run-stage update.

Kill the active managed driver process at that failpoint. Do not kill an idle initiating process while another driver continues normally.

Start a replacement controller and driver. Prove:

- persisted verification is found;
- verification is revalidated or rerun according to policy;
- review begins once;
- stage revision advances once;
- no duplicate verification or review effects;
- old driver is dead;
- replacement owns the run;
- workflow reaches the expected terminal state.

### E2E-09

Implement the approved candidate scenario API first. Then modify a harmless TCSF behavior in a candidate worktree.

The stable parent must:

- build the candidate bundle;
- create isolated HOME, TCSF_HOME, XDG config, OMP config, session, state, evidence, and repository roots;
- launch the candidate process;
- execute C-01 through C-10;
- evaluate their evidence independently;
- prove all stable source, active runtime, state, and evidence fingerprints are unchanged;
- stop at `ready_for_acceptance`;
- perform no promotion action.

The E2E runner must not hard-code `finalState = "ready_for_acceptance"`. It must read the actual durable candidate task and run state.

### E2E-10

Inspect the actual active test runtime and actual active guidance files, not only the source tree.

Prove:

- exactly one active TCSF extension is loaded;
- every expected command is registered exactly once;
- every expected tool is registered exactly once;
- no deprecated lifecycle alias is active;
- active skills and agents contain no forbidden V2 product terminology;
- legacy docs remain only in historical non-normative locations;
- source and active test runtime hashes match the intended candidate snapshot.

## Stage 4. Complete C-01 through C-10

### Candidate process contract

The candidate process must expose a stable-parent-controlled protocol. JSONL is acceptable.

Minimum operations:

```text
ready
inspect_registry
run_scenario
cancel_scenario
shutdown
```

This is a candidate-host protocol, not an OMP-specific core API.

`run_scenario` receives a stable-owned scenario manifest and returns:

- scenario ID;
- candidate source hash;
- process identities;
- event and artifact paths;
- exit status;
- structured result;
- cleanup status.

### Isolation

Every candidate scenario must have isolated:

- HOME;
- TCSF_HOME;
- XDG config and cache roots;
- OMP config;
- OMP sessions;
- task state;
- fixture repositories;
- evidence output;
- temporary directory.

The candidate must not have writable access to parent source, active runtime, parent task state, or parent evidence.

### C-01

Load the extension exactly once. Reject duplicate extension loading.

### C-02

Inspect the loaded registry through the running candidate. Do not parse `bindings/tools.ts` as the verdict source. Reject a missing expected command, missing expected tool, duplicate command, or duplicate tool.

### C-03 through C-10

Execute the normative scenarios through `executeScenario`. Do not return `NOT_RUN` merely because the old loader API lacks a driving seam. The new high-level seam is approved in this directive.

## Stage 5. Implement the real long-run proof

The current `long-run.ts` running E2E-01 twice is a repeatability probe. Preserve it under a probe name.

Create an accelerated mechanics suite proving:

- wall-time budget survives process restart;
- run lease expiry and safe takeover;
- writer lease renewal during a long turn;
- driver heartbeat expiry and reconciliation;
- retry counters survive restart;
- waiting state does not busy-loop;
- logs remain bounded while full output is stored in artifacts;
- cancellation survives restart;
- no leaked worker, driver, verification, reviewer, or fixture processes;
- no stale lease or claim files remain.

Then run one substantial real unattended fixture with:

- more than one implementation turn;
- deterministic verification failure;
- same-session repair;
- verification rerun;
- deterministic reviewer rejection;
- same-session semantic repair;
- a second fresh reviewer;
- persisted counters;
- at least one controlled restart;
- bounded logs;
- full cleanup.

A literal twelve-hour wait is not required. The wall-time and expiry mechanics must use an accelerated clock, and the real workflow must be long enough to cross multiple heartbeat and lease-renewal intervals.

## Stage 6. Repair evidence and report semantics

The final report validator must validate behavior, not only filenames and self-declared booleans.

For each PASS:

- read the catalog required actors;
- read required process boundaries;
- read required observations;
- read required evidence files;
- verify the scenario evidence contains each required item;
- verify the executed source hash was captured at scenario start;
- verify the verdict oracle derives from raw evidence;
- reject hard-coded `realOmpBoundary: true` or generic process-boundary labels;
- reject a current source hash attached to old evidence;
- reject a PASS generated only from a self-authored `verdict.json`.

Compute `overall` from the normative rules. Do not hard-code it.

The final portable acceptance bundle must live under the durable acceptance root. It must include or immutably reference:

- normative spec bytes;
- catalog bytes;
- complete source snapshot or manifest;
- all runner sources;
- raw command logs;
- raw scenario evidence;
- candidate parent and child evidence;
- generator and validator source;
- final report;
- independent audit result;
- rollback instructions.

It must validate after relocation to another directory on a compatible machine. Absolute paths may appear as metadata, but they cannot be the only way to locate evidence.

## Execution order

Perform work in this order:

1. preserve the latest `/tmp` evidence;
2. downgrade unsupported PASS claims;
3. fix lease renewal, worker-loss classification, driver takeover, UI responses, and timeout policy;
4. repair and run E2E-01;
5. repair and run E2E-02;
6. repair and run E2E-03;
7. repair and run E2E-04;
8. repair and run E2E-05;
9. repair and run E2E-08;
10. repair and run E2E-06;
11. implement enforceable write containment and run E2E-07;
12. run E2E-10;
13. implement the high-level candidate API;
14. run C-01 through C-10;
15. run E2E-09;
16. run accelerated long-run mechanics and the substantial real workflow;
17. generate and validate the portable final evidence bundle;
18. run a fresh independent read-only audit and repair blocking findings.

Do not stop after producing another truthful FAIL report. Continue to the next independently runnable item whenever one scenario fails.

## Work already authorized

Do not ask the user for permission to:

- extend `CandidateRuntimePort` as specified above;
- add test-only fault injection ports or decorators;
- add process-backed deterministic reviewer fixtures;
- run isolated real OMP scenarios;
- kill and replace fixture workers or drivers;
- launch a controlled operator OMP process;
- create isolated candidate homes and repositories;
- probe local sandbox capabilities using disposable fixtures;
- execute adversarial writes inside disposable fixtures;
- use accelerated clocks;
- change tests, adapters, manifests, evidence collectors, generator, and validator;
- choose a safe local model profile for non-normative capability probes.

Do not commit, push, merge, deploy, promote, or replace a known accepted production runtime.

## Stop and escalation rules

Stop only when one of these is true:

- no safe containment method can prevent or fail-closed detect writes outside approved roots, and every approved isolated-host fallback has failed;
- no documented OMP resume path can preserve the same logical session across a real operator handoff;
- actual OMP session recovery cannot determine whether an interrupted prompt was accepted, and no safe idempotency or reconciliation method can prevent duplicate work;
- candidate isolation cannot prevent mutation of the stable parent through every approved fallback;
- the implementation specification must change to proceed;
- a required experiment would perform an irreversible action outside disposable fixtures.

Provider variability, a live reviewer missing a defect, a live implementer declining an adversarial action, and the old candidate loader API are not human-decision conditions. Redesign the deterministic test or implement the approved port extension.

An escalation must include:

- exact failed invariant;
- raw evidence paths;
- every attempted approach;
- every attempted fallback;
- concrete options;
- a recommendation;
- named H, E2E, C, and AC consequences.

## Final response contract

Return:

1. implemented architecture changes;
2. exact runtime defects fixed;
3. deterministic normative scenario matrix;
4. separate live-model capability matrix;
5. candidate scenario matrix;
6. long-run matrix;
7. hypotheses with canonical titles and durable evidence;
8. acceptance criteria with evidence-backed PASS or FAIL only;
9. remaining failures;
10. portable bundle path and manifest hash;
11. source and active test runtime hashes;
12. rollback instructions;
13. explicit confirmation that no commit, push, merge, deploy, promotion, or accepted-runtime replacement occurred.
