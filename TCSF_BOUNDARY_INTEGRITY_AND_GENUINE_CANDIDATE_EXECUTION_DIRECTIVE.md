# TCSF boundary integrity and genuine candidate execution directive

## Status and authority

Read these inputs completely before editing:

1. `TCSF_IMPLEMENTATION_SPEC.md`
2. the current TCSF source tree
3. the portable acceptance bundle `tcsf-acceptance-final-20260830T220846Z`
4. this directive

The implementation specification remains the sole authority for every H, E2E, C, and AC identifier. This directive selects repair order and evidence requirements. It does not redefine the normative identifiers.

Preserve the current implementation. Do not restart from scratch.

The current checkpoint contains real progress:

- a credible autonomous OMP happy path;
- real same-session verification and semantic repair evidence;
- a real operator OMP process in the foreground experiment;
- durable run state, revision CAS, leases, and process tracking;
- a strict reviewer protocol;
- a generated conservative final report;
- a portable evidence bundle with a valid manifest under its recorded file and symlink hashing rules.

The current checkpoint is not accepted as TCSF. The final `overall: FAIL` is correct.

No human product decision is required for this pass. All routine source repairs, fixture creation, process termination, candidate isolation, deterministic fault injection, sandbox probes, and scenario execution described below are already authorized.

Do not commit, push, merge, deploy, promote, or replace a known accepted runtime.

## Mandatory verdict corrections

Before generating another report, preserve the current evidence and classify it honestly.

Retain these results:

- E2E-01 as the strongest current normative pass, subject to a final oracle review;
- E2E-02 as provisional real-OMP repair evidence, to be rerun after production test hooks are removed;
- E2E-03 as a live-model capability pass and useful integration evidence;
- the nine component probes under their component IDs;
- C-01 as an isolated candidate loader probe;
- the current final report as historical evidence.

Downgrade or split these results:

- E2E-04: component evidence for durable decision storage, normative scenario not yet proven across real process restart boundaries;
- E2E-05: FAIL or NOT_RUN, because the worker is killed only after a completed implementation turn and no replacement OMP host resumes an in-flight logical turn;
- E2E-06: partial foreground capability evidence, normative handoff not yet proven because the nonce is copied into the operator prompt and no post-return controller turn proves reacquisition;
- E2E-08: FAIL or NOT_RUN, because the runner kills the initiating child rather than the managed driver process that records the failpoint;
- E2E-09: FAIL or NOT_RUN, because C-03 through C-10 do not execute candidate TCSF behavior;
- E2E-10: component source and loader lint, normative active-runtime scenario not yet proven;
- C-02: partial registry probe until the complete expected command and tool registry is compared;
- C-03 through C-10: NOT_RUN;
- long-run mechanics: NOT_RUN.

Do not delete old PASS files. Mark them superseded and record the reason.

## Stage 0. Contain the E2E-07 source mutation incident

The current source archive contains:

```text
dot_omp/private_agent/extensions/tcsf/forbidden.txt
```

Its content is exactly:

```text
unauthorized-test-write
```

The file timestamp matches the last E2E-07 execution. The write came from production `OmpRpcAgentRuntime.waitForTurn()`, which calls a test hook after a completed turn. The hook resolves `forbidden.txt` against the run-driver current working directory. The driver currently starts with `cwd: process.cwd()`, which was the TCSF source directory.

Treat this as a boundary incident, not merely a failed assertion.

Before deleting anything:

1. Snapshot the complete source tree and mutable active test runtime.
2. Record the path, bytes, size, timestamp, SHA-256, and Git status of every `forbidden.txt` and every file containing `unauthorized-test-write`.
3. Search the active runtime, dotfiles source, task roots, and acceptance roots.
4. Record whether the active runtime contains the same mutation.
5. Remove only files whose exact bytes and origin match this test artifact. Preserve any unrelated user file.
6. Record before and after full-tree hashes.
7. Add an incident report to the next evidence bundle.

Do not synchronize source to the active runtime until this incident is repaired and the source tree is clean.

Change `LocalRunDriverHost.start()` so the driver current working directory is an explicit run-owned directory, never the invoking source directory. Persist that cwd in the driver manifest.

Add a test that starts a driver while the caller cwd is the TCSF source directory and proves that relative paths cannot create files there.

## Stage 1. Remove test behavior from production adapters

Remove all test-only environment branches from production runtime code, including:

```text
TCSF_TEST_UNAUTHORIZED_WRITE_TARGETS
TCSF_FORCE_FIRST_VERIFICATION_FAILURE
```

The production runner must not forward them. `OmpRpcAgentRuntime` must not perform adversarial writes. `ShellVerificationRunner` must not manufacture a failure.

Implement deterministic test behavior through injected test ports or decorators:

- a `VerificationRunner` decorator that fails the selected invocation;
- an `ExecutionHost` test implementation that runs an adversarial worker inside the same containment policy as production;
- a `FailpointPort` or equivalent injected callback for crash synchronization.

Do not use generic process environment variables that alter production adapter semantics.

Add a source test that fails if production files under `app`, `adapters`, `bindings`, `core`, `ports`, `runner.ts`, or `run-driver-process.ts` contain `TCSF_TEST_` or fixture-specific filenames.

Rerun E2E-02 using the injected verification decorator or a harness-controlled verification command. The fault must not be visible to or controllable by the implementer model.

## Stage 2. Make candidate execution genuine

The current `executeScenario()` starts a candidate OMP process but never waits for candidate readiness, never sends it a scenario, and never consumes candidate output. It separately launches a stable-source Bun script and grades that script. C-03 through C-10 write the expected facts directly into JSON files. This is not candidate execution.

Replace it with a real candidate-host protocol.

### 2.1 Required candidate-host protocol

The isolated candidate process must expose a stable-parent-controlled protocol with at least:

```text
ready
inspect_registry
run_scenario
cancel_scenario
shutdown
```

JSONL over inherited pipes, a Unix-domain socket, or an isolated candidate-owned file queue is acceptable. The protocol endpoint must run candidate code built from the candidate source snapshot.

Two implementations are acceptable:

1. The candidate extension starts a narrow control endpoint when launched in candidate-host mode.
2. A candidate-host executable is bundled from the candidate source and imports the candidate factory services, while OMP loading is verified in the same isolated candidate boundary.

The stable parent must not import the candidate source into its own process.

### 2.2 Required ownership

The stable parent owns:

- immutable scenario definitions;
- fixture creation;
- parent and active-runtime fingerprints;
- timeouts and cancellation;
- required observations;
- raw evidence collection;
- verdict computation.

The candidate owns only execution inside its isolated root.

The candidate must not grade itself. A child JSON field such as `passed: true` is not an oracle.

### 2.3 Forbidden candidate shortcuts

Remove these patterns from normative candidate scenarios:

```text
TCSF_CANDIDATE_CHILD
TCSF_STABLE_SOURCE_INDEX
TCSF_STABLE_ACTIVE_INDEX
stable-source tests/candidate/c-XX.ts launched as the scenario implementation
hand-written JSON that states workerLost, repaired, restarted, or ready_for_acceptance
```

A scenario manifest may describe a fixture and requested operation. It may not contain an argv that runs a stable-source script which fabricates expected state.

### 2.4 Candidate process liveness and cleanup

`executeScenario()` must:

1. start the candidate process;
2. wait for an authenticated `ready` frame;
3. record candidate PID, source hash, bundle hash, HOME, TCSF_HOME, config root, session root, task root, fixture roots, and evidence root;
4. send `run_scenario` to that process;
5. receive candidate-owned events and durable artifact references;
6. fail if the candidate process exits before the terminal scenario result;
7. drain stdout and stderr continuously;
8. send `shutdown` and wait for graceful exit;
9. escalate to SIGTERM and SIGKILL only when required;
10. report cleanup failure after cleanup actually completes.

Fix the current `cleanupSucceeded` return bug. Do not compute the returned value before the `finally` cleanup result is known.

### 2.5 Exact C-01 through C-10

C-01 must prove one candidate extension load and reject a duplicate load.

C-02 must compare the complete observed command and tool registry to an explicit expected registry. Include all eight TCSF commands and all expected TCSF tools. Reject missing, duplicate, and unexpected legacy lifecycle registrations.

C-03 through C-10 must execute the exact normative behaviors through candidate-owned TCSF services and candidate-owned OMP workers where the scenario requires OMP.

For each candidate scenario, the stable parent must validate raw task, run, execution, session, Git, process, and cleanup evidence. Do not trust candidate prose or a candidate-authored verdict.

Integrate the full C-01 through C-10 pack into normal `advanceCandidate()` for self-changes. The production factory currently calls only `inspectCandidate()`. Loader-only validation is not accepted.

Repair `isSelfChange()` with path-aware matching for the real dotfiles layout. A self-change includes:

- TCSF core, ports, adapters, bindings, drivers, tests, and conformance code;
- TCSF skills and agents;
- extensions used by TCSF;
- runtime configuration contracts;
- candidate validation infrastructure.

Add positive and negative tests using actual repository paths and writable-scope patterns such as `dot_omp/private_agent/extensions/tcsf/**`.

## Stage 3. Repair the exact recovery scenarios

### E2E-04: real decision process restart

Use separate OS processes for:

- the original controller and driver;
- the waiting interval;
- the resolver;
- the replacement controller and driver.

The scenario must prove:

- a complete durable request exists;
- the run and task enter waiting state;
- the original controller and driver exit;
- no active driver loop spins while waiting;
- a later process loads the request by ID;
- one resolution succeeds;
- a conflicting second resolution fails;
- a replacement driver resumes from the saved stage;
- completed implementation, verification, and review effects are not repeated.

Using the public factory decision API is acceptable for this state-machine conformance scenario. Keep model-initiated decision requests as a separate production capability requirement.

### E2E-05: kill the real in-flight OMP worker

Wait for:

```text
turn intent persisted
prompt dispatch acknowledged
turn completion absent
```

Then kill the actual OMP host PID. Do not wait for a `.complete.json` file. Do not substitute driver replacement for worker replacement.

Prove:

- the old OMP PID died;
- worker loss was classified as infrastructure loss, not semantic failure;
- a new OMP PID and transport were created;
- the same session ID and session file were resumed;
- the logical turn was reconciled exactly once;
- the prompt was not applied twice;
- the recovery counter is bounded and durable;
- the workflow continues;
- no old worker remains.

Repair `reconcileTurn()`. It must not use substring search over the entire session and treat any old assistant final answer as completion of a new prompt.

Use an explicit logical-turn marker and content hash in the dispatched prompt metadata or a documented OMP message identity. Parse JSONL in order. Associate the exact user prompt marker with the first subsequent terminal assistant response for that turn. An earlier assistant response must never complete a later turn.

### E2E-06: prove a full foreground round trip

Before handoff, bind a continuity nonce to existing session history. The operator prompt must not contain the nonce value.

Required sequence:

1. controller sends or records a pre-handoff continuity marker in the exact logical session;
2. controller pauses input and transfers the writer lease atomically;
3. a separate operator OMP process resumes the exact session file;
4. the operator reads the existing history and returns the marker without receiving its value in the prompt;
5. a concurrent controller input is denied before send;
6. the operator performs a second observable turn or records an operator-owned history entry;
7. the operator exits;
8. the nonce is consumed once;
9. the controller reacquires ownership;
10. the controller sends a post-return turn in the same session;
11. session ID, session file, ordered history, message count, and lease generations prove continuity.

Wrong nonce, replay, restart during handoff, and stale lease release must fail closed.

### E2E-07: enforce and test the actual write boundary

Do not let the parent test process perform the forbidden write. Do not rely on a language model voluntarily attacking the system.

First implement an enforceable worker containment mechanism at `ExecutionHost` or a replaceable host adapter.

Probe the preferred local macOS sandbox mechanism with disposable fixtures. It must restrict writes to approved worktree and task roots while allowing required OMP operation. If the local mechanism cannot prove this policy, use the approved isolated-host or container fallback.

The deterministic adversarial worker must run inside the same containment boundary as a managed worker and attempt:

- an allowed worktree write;
- original checkout write;
- reference repository write;
- `..` traversal;
- symlink escape;
- staged unauthorized write;
- committed unauthorized write;
- nested untracked directory;
- Bash child and grandchild writes;
- a write to an outside canary.

The parent supplies fixture paths and observes results. It must not make the mutations itself.

Prove denial where possible, post-turn detection, safe restoration, unchanged outside canaries, task failure, no continuation to acceptance, and complete process cleanup.

Capture source and active-runtime full-tree hashes immediately before and after E2E-07. Any mutation outside the disposable fixture is an immediate harness failure.

### E2E-08: kill the failpoint owner

The failpoint artifact records the PID of the managed driver process that reached:

```text
after verification evidence persisted
before next stage update
```

Kill exactly that PID. Do not kill the idle initiating child.

The failpoint must block or pause the driver long enough for the parent to terminate it before stage transition.

Start a replacement driver and prove:

- the old driver is dead;
- the replacement owns the run;
- persisted verification is found;
- verification is revalidated or rerun according to policy;
- the run revision advances once;
- review begins once;
- no duplicate review, repair, or verification side effect appears;
- the workflow reaches the expected terminal state.

### E2E-10: inspect the actual active test runtime

Run a fresh active OMP loader against the intended mutable active test installation.

Prove from observed runtime data:

- exactly one active TCSF extension is loaded;
- every expected command is registered exactly once;
- every expected tool is registered exactly once;
- no deprecated lifecycle alias is active;
- active skills and agents contain no forbidden product `V2` terminology;
- legacy material exists only under history locations;
- representative legacy manifests remain byte-identical and are not interpreted as TCSF tasks;
- source and active test-runtime hashes match the intended candidate snapshot.

Do not parse source `bindings/tools.ts` as the verdict source. Do not call source directories `activeExtensions`.

## Stage 4. Repair remaining runtime invariants

### 4.1 Writer lease CAS

`renewWriter()` must execute under the transition lock and compare the supplied token, generation, owner, and host ID with the persisted current lease before renewal. A stale controller must not renew an operator lease or a newer controller lease.

Add tests for stale renew, stale release, operator takeover, controller reacquisition, corrupt lease, and restart.

### 4.2 Stage-wide run ownership

Run lease renewal currently protects active implementation turns. Extend ownership protection to verification, review, candidate validation, and other potentially long stages.

Use one stage guard that:

- renews before expiry;
- records heartbeat evidence;
- fails closed on lost ownership;
- stops the active operation when ownership is lost;
- cannot race with the stage CAS update.

### 4.3 Driver process identity

PID existence alone is not process identity. Persist and verify a start token and an OS-observable process start identity before stopping or replacing a driver. Protect against PID reuse.

A waiting run must leave a truthful `waiting` or cleanly stopped driver manifest. It must not be recorded as `failed` merely because the driver loop returned a non-terminal waiting result.

### 4.4 Verification process safety

Replace direct-child timeout handling with managed process-tree execution:

- dedicated process group or equivalent ownership;
- streaming stdout and stderr to durable files;
- bounded in-memory summaries;
- explicit timeout metadata;
- SIGTERM grace period;
- SIGKILL escalation;
- descendant cleanup;
- configured default timeout when no per-run override exists.

Do not infer timeout only from exit code 137 or 143.

### 4.5 Reviewer attempt identity

Do not use process-local review counters as durable attempt identity. Derive attempt numbers from durable run counters or allocate an atomic unique attempt ID. A controller restart must not overwrite a prior review-attempt artifact.

Record the effective model and provider for every live reviewer attempt.

### 4.6 Model-initiated critical decisions

The autonomous implementer currently runs without extensions, skills, or rules and cannot use the public decision tool.

Add one narrow, bound decision-request mechanism that does not grant broad extension access. Acceptable approaches include:

- a strict structured terminal result envelope parsed by the runtime;
- a minimal trusted IPC channel exposed only to the current execution;
- a dedicated no-write decision tool provided by a constrained worker adapter.

Validate category, question, evidence, options, recommendation, and resume stage. Do not let arbitrary sessions resolve or forge a request.

## Stage 5. Make the conformance validator behavioral

The current validator is a useful structural validator. It still accepts self-declared booleans and generic process-boundary labels.

For every PASS, read the canonical catalog and enforce:

- required actors;
- exact process boundaries;
- required preconditions;
- required observations;
- required raw evidence files;
- source hash captured at scenario start;
- verdict derived from raw evidence, not from `verdict.json` alone.

Add scenario-specific checks:

- E2E-05 requires an in-flight dispatch without completion, old and replacement OMP PIDs, same session, and exact logical-turn reconciliation;
- E2E-06 requires ordered session-history evidence, operator process identity, controller denial, nonce history binding, and a post-return controller turn;
- E2E-08 requires the killed PID to equal the failpoint owner PID and a replacement driver identity;
- E2E-09 requires candidate-owned task and run artifacts and a candidate process that stayed alive through scenario execution;
- E2E-10 requires active runtime observations, not source parsing;
- C-03 through C-10 require candidate-owned execution evidence, not stable-source child JSON.

Remove hard-coded `realOmpBoundary: true` and generic process-boundary arrays from report generation. Compute them from evidence.

Compute acceptance criteria from explicit mappings of required static checks, hypotheses, E2Es, candidate scenarios, and long-run mechanics. Keep all unsupported criteria red.

## Stage 6. Make the portable bundle genuinely portable

The current manifest hashes all 3,336 entries correctly under its file and symlink rules. However, two E2E-07 `escape` entries are absolute symlinks into deleted `/var/folders/...` fixture paths.

A relocatable evidence archive must not contain live absolute symlinks to external temporary directories.

For symlink evidence:

- store link metadata and target text in a regular JSON evidence file;
- preserve a safe relative fixture symlink only when its target is inside the copied fixture root;
- never archive a dangling absolute link as an active filesystem object;
- reject evidence symlinks that escape the acceptance root.

The final archive must validate after extraction to a different absolute path.

## Stage 7. Complete long-run and hypotheses

The current long-run script executes E2E-01 twice. Preserve it as a repeatability probe.

Create accelerated mechanics tests for:

- wall-time budget across restart;
- heartbeat expiry and safe takeover;
- run and writer lease renewal;
- bounded retry counters across restart;
- waiting without busy loop;
- bounded summaries with full durable streams;
- cancellation across restart;
- stale process denial;
- no worker, driver, reviewer, verification, descriptor, claim, lease, worktree, or temporary-root leaks.

Then execute one real unattended workflow with:

- at least two implementation turns;
- deterministic verification failure;
- same-session repair;
- verification rerun;
- deterministic reviewer rejection for conformance;
- same-session semantic repair;
- a second fresh reviewer;
- at least one controlled process restart;
- persisted counters;
- lease intervals crossed;
- complete cleanup.

After runtime and scenario repairs, rerun H-01 through H-11 with durable evidence. Use `REJECTED_WITH_FALLBACK` where the preferred capability fails but the approved fallback is executed and proven. HERDR remains optional.

## Execution order

Execute in this order:

1. preserve current source, active runtime, and evidence;
2. contain and document the E2E-07 source mutation;
3. remove production test hooks and change driver cwd;
4. rerun compile, unit, adapter, and source-boundary tests;
5. rerun E2E-01 and E2E-02;
6. implement genuine candidate-host execution;
7. run exact C-01 and C-02;
8. run C-03 through C-10 through the candidate process;
9. repair and run E2E-04;
10. repair and run E2E-05;
11. repair and run E2E-08;
12. repair and run E2E-06;
13. implement enforceable containment and run E2E-07;
14. run active E2E-10;
15. run E2E-09 under the immutable parent;
16. run accelerated long-run mechanics and the substantial workflow;
17. rerun H-01 through H-11;
18. run a fresh independent read-only audit;
19. generate the final report and portable bundle.

A failure in one independently isolated scenario does not authorize stopping the whole pass. Record it, repair it when possible, and continue with scenarios that do not depend on it.

## Stop and escalation rules

Stop only when one of these is true:

- no tested local or isolated-host fallback can enforce worker write containment;
- same-session OMP resume cannot preserve history through any documented path;
- genuine candidate execution cannot be isolated from parent source, state, and evidence through the approved protocol or its safe fallback;
- safe restoration would risk pre-existing user changes outside disposable fixtures;
- a required experiment would perform an irreversible action outside isolated fixtures;
- the approved architecture must change.

An escalation must include exact raw evidence, all attempted fallbacks, concrete options, a recommendation, and the effect on named H, E2E, C, and AC identifiers.

Do not stop merely because the final report remains red. Do not request authorization for work already listed in this directive.

## Final response contract

Return:

1. implemented architecture;
2. incident remediation;
3. hypotheses with exact canonical titles and durable evidence;
4. exact E2E-01 through E2E-10 results;
5. exact C-01 through C-10 results;
6. accelerated long-run result;
7. grouped test counts and command logs;
8. source, active runtime, parent, and candidate hashes;
9. portable manifest verification after relocation;
10. acceptance criteria with only PASS or FAIL;
11. remaining concrete failures;
12. rollback path and command.

Do not call TCSF complete while `overall` is `FAIL`.
