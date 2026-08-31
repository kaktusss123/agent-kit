# TCSF exact conformance completion directive

## 1. Purpose

Continue from the current TCSF source without restarting the implementation.

This pass has one goal: make the executed behavior match the exact normative definitions in `TCSF_IMPLEMENTATION_SPEC.md`.

This is not a reporting pass. Do not stop after producing another red report. Repair runtime behavior, execute the exact scenarios, and preserve raw evidence.

The normative specification is the sole authority for every H, E2E, C, and AC identifier. A later prompt, runner name, report field, or implementation convenience may not weaken those definitions.

No product decision is required. Tests, disposable fixtures, isolated OMP processes, controlled process deaths, sandbox probes, deterministic test adapters, candidate snapshots, process restarts, and accelerated clocks are already authorized.

Do not commit, push, merge, deploy, replace the active runtime, or promote the candidate.

## 2. Current accepted baseline

Preserve these results and rerun them after the source is frozen for the final pack:

- E2E-01 is an accepted real autonomous happy path.
- E2E-02 is an accepted deterministic verification repair through the same logical implementer session.
- The source mutation incident is repaired. Production test-only environment branches were removed and the driver now uses a run-owned cwd.
- Frozen contract import, run revision CAS, strict reviewer JSON, driver ownership, writer-lease transfer, source-boundary regression coverage, and portable evidence file hashing are useful retained work.
- E2E-03 is an honest failure.
- E2E-09 is an honest failure.
- Overall acceptance remains FAIL.

Do not claim the following current verdicts as normative PASS:

- E2E-04
- E2E-05
- E2E-06
- E2E-07
- E2E-10

Treat E2E-08 as unaccepted until its exact crash owner and exactly-once reconciliation predicates are encoded and rerun.

Treat C-03 through C-10 as unaccepted. Their current candidate process is real, but the scenarios do not prove their normative behaviors. Do not build a full pack from mixed independent reruns.

## 3. Preserve the current state

Before editing:

1. Snapshot the current source tree and status.
2. Copy the current portable evidence bundle byte-for-byte.
3. Record SHA-256 for both input archives, the extracted source tree, and the extracted evidence tree.
4. Preserve the current `FINAL_MANIFEST.json`, report, candidate pack, E2E runners, raw scenario evidence, and incident record.
5. Record the current source hash and active runtime hash separately. They are different and must remain distinguishable.
6. Do not rewrite historical verdict files.

The final pack must contain command logs for TypeScript compilation, unit tests, focused tests, each normative runner, candidate pack execution, long-run mechanics, report generation, report validation, manifest generation, and manifest validation.

## 4. Repair evidence integrity

### 4.1 Manifest algorithm

`FINAL_MANIFEST.json` currently lists valid per-file hashes, but its `treeHash` is not reproducible using its documented rule.

Implement one canonical algorithm in source and use the same function for generation and validation.

Recommended definition:

```text
for every regular file except FINAL_MANIFEST.json, sorted by normalized relative path:
    sha256.update(uint64be(pathByteLength))
    sha256.update(pathUtf8Bytes)
    sha256.update(uint64be(fileByteLength))
    sha256.update(fileBytes)
```

Store an algorithm ID, not a prose-only description. Add tests for ordering, path ambiguity, changed bytes, changed path, extra file, missing file, symlink rejection, and relocation.

The final report must state three distinct hashes:

- archive SHA-256;
- `FINAL_MANIFEST.json` SHA-256;
- reproducible tree hash.

Never substitute one for another.

### 4.2 Executed source identity

Every PASS scenario must record the immutable source snapshot hash used to execute it. The report generator must read that hash from scenario evidence. It must not attach the current source hash after execution.

A source edit after one scenario invalidates the aggregate pack. Start a new pack from a new immutable snapshot.

### 4.3 No mixed candidate pack

A complete candidate pack must satisfy all of these conditions:

- one candidate source snapshot;
- one stable-parent source snapshot;
- one active-runtime fingerprint;
- one scenario-pack run ID;
- C-01 through C-10 executed in order;
- no source edits during the pack;
- no replacement of one failed result with an older or later standalone rerun;
- one parent-before and one parent-after fingerprint;
- one final state obtained from the actual candidate task;
- all candidate-owned and parent-owned processes cleaned up.

Standalone reruns may remain as diagnostic evidence, but they may not be merged into the normative pack result.

## 5. Repair remaining runtime invariants

### 5.1 Writer-lease renewal must use CAS

`LocalProcessHost.renewWriter()` currently reads the persisted lease and renews it without proving that the caller still owns the same token, generation, host, and owner identity.

Fix it under the transition lock:

1. load the persisted lease;
2. compare host ID, token, generation, and owner to the caller lease;
3. reject any mismatch;
4. write generation-preserving renewal atomically;
5. return the renewed lease.

Add adversarial tests where an old controller tries to renew an operator lease and where an earlier generation tries to renew a replacement controller lease.

### 5.2 Do not suppress lease errors on cancellation

`cancelRun()` must not turn corrupt JSON, token mismatch, generation mismatch, or owner mismatch into successful cleanup.

Only a proved idempotent already-released state may be ignored. Persist cleanup failure and keep the run fail-closed when ownership cannot be reconciled.

### 5.3 Renew ownership for every long stage

Run ownership is currently renewed around implementation turns, but verification, review, and candidate validation can also exceed the run lease TTL.

Create one stage guard used by all long operations. It must renew the run lease, and any relevant writer lease, until the operation terminates. If renewal loses CAS ownership:

- interrupt or terminate the operation;
- persist an infrastructure-loss record;
- do not let the stale controller update stage state.

### 5.4 Exact turn reconciliation

`reconcileTurn()` must use the durable logical turn ID and content hash. Exact prompt text alone is not a sufficient identity.

Dispatch a machine-readable marker that survives in OMP session history. Parse session JSONL in order and associate:

```text
exact logical marker
exact content hash
matching user message
first terminal assistant answer for that message
```

An earlier assistant answer must never complete a later turn. Repeated equal prompts must remain distinguishable.

Add tests for repeated prompt text, partial user record, old final answer, crash before accept, crash after accept, crash after terminal answer, and malformed session tail.

### 5.5 Verification process control

Repair `ShellVerificationRunner`:

- launch each command in a controllable process group or equivalent tree boundary;
- stream stdout and stderr to durable artifacts while retaining only bounded tails in memory;
- use the configured default timeout correctly;
- classify timeout from the timer state, not from exit code alone;
- send SIGTERM to the process tree;
- wait a bounded grace period;
- escalate to SIGKILL;
- wait for confirmed process termination;
- report cleanup failure separately;
- add a real grandchild process timeout test against this adapter.

### 5.6 Reviewer attempt identity

Reviewer attempt IDs must come from durable run state or an atomic artifact claim. A process restart must not overwrite attempt 1.

Record effective model identity, exact session reference, exact source revision, and raw protocol artifact references for each review attempt.

## 6. Execute the exact E2E scenarios

### 6.1 E2E-03 semantic review repair

Keep the live-model run as a capability probe. It must not be the conformance oracle.

Add a process-backed deterministic reviewer adapter for the normative scenario:

1. first fresh reviewer returns one exact blocking finding for a seeded semantic defect;
2. the same logical implementer session receives the finding;
3. verification reruns;
4. a second fresh reviewer process returns pass;
5. reviewer session identities differ;
6. implementer session identity remains the same.

Then run a separate live-reviewer capability probe and report its result independently.

### 6.2 E2E-04 real decision process restart

Use separate OS processes for:

- original controller;
- original driver;
- waiting interval observer;
- later decision resolver;
- replacement controller and driver.

Prove:

- a complete durable request exists;
- task and run enter waiting state;
- original controller and driver exit;
- no driver loop spins while waiting;
- a later process resolves by decision ID;
- one resolution succeeds;
- a conflicting resolution fails;
- replacement driver resumes from the recorded stage;
- completed prior effects are not repeated.

Two factory objects in one PID do not satisfy this scenario.

### 6.3 E2E-05 kill the in-flight OMP worker

Wait for:

```text
intent exists
dispatch exists
completion does not exist
```

Then kill the actual OMP worker PID. Do not wait for `.complete.json`. Do not kill the driver as a substitute.

Prove:

- old worker PID dies;
- transport loss is classified as infrastructure loss;
- replacement worker PID differs;
- same session ID and session file are resumed;
- the same logical turn is reconciled exactly once;
- prompt delivery count is exactly one;
- recovery counter is durable and bounded;
- workflow continues;
- no old worker remains.

The uniqueness of filenames is not a duplicate-delivery oracle.

### 6.4 E2E-06 full foreground round trip

Bind a random continuity marker to the session history before handoff. The operator prompt must not contain its value.

Required sequence:

1. controller records marker in the exact logical session;
2. controller closes its transport and atomically transfers writer ownership;
3. separate operator OMP process resumes exact session file;
4. operator retrieves the marker from prior history without receiving the value in the prompt;
5. concurrent controller input is rejected before send;
6. operator performs an observable second turn;
7. operator exits;
8. return consumes nonce once;
9. replay and wrong nonce fail;
10. controller reacquires ownership;
11. controller sends a post-return turn;
12. session ID, session file, message order, message count, and lease generations prove continuity.

A nonce copied into the operator prompt is not continuity evidence.

### 6.5 E2E-07 enforce the write boundary

The current driver-cwd regression test is useful, but it is not E2E-07. Rename it to a component or regression probe.

Implement an enforceable worker containment adapter. Prompt instructions and post-hoc Git inspection are not containment.

Probe this fallback order with disposable fixtures:

1. an installed macOS process sandbox that can restrict writes to task-owned roots;
2. an isolated container or VM execution host;
3. if neither can be proved, fail closed and mark untrusted production execution unsupported.

The normative deterministic adversarial worker must run inside the same host boundary as a managed worker and attempt:

- allowed worktree write;
- original checkout write;
- reference repository write;
- parent traversal;
- absolute external write;
- symlink escape;
- staged unauthorized write;
- unauthorized commit;
- child-process write;
- grandchild-process write.

Expected result:

- denied mutations never reach protected roots when the host can deny them;
- any mutation not denied is detected;
- task-owned worktree is restored safely;
- protected original and reference repositories remain byte-identical;
- task fails closed and never reaches `ready_for_acceptance`.

The parent test process must not perform the forbidden write itself.

### 6.6 E2E-08 exact controller crash reconciliation

Retain the current failpoint structure, then strengthen its oracle:

- the killed PID must equal the failpoint `processId`;
- verification evidence must exist before the kill;
- no review artifact may exist before the kill;
- record verification attempt count before and after restart;
- record stage transition events before and after restart;
- prove exactly one transition from verify to review;
- prove whether verification was revalidated or rerun;
- no stale controller write may succeed after restart;
- final cleanup must show no old controller or driver.

Rerun and only then mark E2E-08 PASS.

### 6.7 E2E-10 inspect the active runtime

Do not inspect the source sibling directory and call it active runtime.

The runner must take explicit source and active roots and prove:

- exactly one active TCSF extension entrypoint;
- active OMP loads it without duplicate commands or tools;
- complete expected command and tool registry;
- active skills and agents contain no V2 product terminology;
- compatibility aliases contain no lifecycle implementation;
- historical docs are outside the active namespace and marked non-normative;
- source and active hashes are reported separately.

If source has not been promoted to active runtime, the result must say that active is an older installation. Do not copy source into active merely to make this test green.

## 7. Build a genuine immutable candidate pack

### 7.1 Immutable candidate executable

`executeScenario()` currently builds a candidate bundle and then launches live `candidate-host.ts` from the editable source tree. Fix this.

Create an immutable candidate snapshot before the pack. Then either:

- bundle the candidate host and all imported candidate services into one executable; or
- run the host only from the immutable snapshot and prove the complete snapshot hash.

Do not import or execute files from the live editable source tree during a candidate scenario.

Make the snapshot read-only where the platform permits. Abort the pack if its hash changes.

### 7.2 Candidate protocol

Implement a narrow versioned protocol with a monotonic request sequence.

Authenticate or bind all mutating frames, including:

- `run_scenario`;
- `cancel_scenario`;
- `shutdown`.

Implement real cancellation of the active scenario. The candidate host must track the active run and terminate its driver and workers before reporting cancellation complete.

A terminal result must include the request sequence, scenario ID, candidate snapshot hash, task ID, run ID, and artifact references. The stable parent must reject mismatched or replayed frames.

### 7.3 Stable-parent ownership

The stable parent owns:

- scenario definitions;
- fixture repositories;
- fault injection controls;
- timeouts;
- protected root fingerprints;
- process observations;
- evidence requirements;
- verdict computation.

The candidate may emit facts and artifact references. It may not determine PASS.

### 7.4 Exact C-01 through C-10

C-01:

- prove one extension load;
- attempt an explicit duplicate load and prove rejection or duplicate detection.

C-02:

- compare the complete observed command and tool registry to the explicit expected set;
- reject missing, duplicate, unexpected, and legacy lifecycle entries.

C-03:

- run an approved fixture with no existing interactive worker;
- reach `ready_for_acceptance` through candidate TCSF.

C-04:

- inject deterministic first verification failure through a candidate test port;
- prove same logical implementer session repairs it.

C-05:

- use deterministic fresh reviewer processes;
- first rejects seeded semantic defect;
- same implementer session repairs;
- second fresh reviewer passes.

C-06:

- persist a decision;
- exit original candidate controller and driver;
- resolve later from another process;
- resume without repeating completed work.

C-07:

- kill actual candidate OMP worker while a dispatched turn is incomplete;
- replacement host resumes same logical session exactly once.

C-08:

- run an actual operator OMP process;
- prove history-bound marker continuity, lease exclusion, return, and post-return controller turn.

C-09:

- run the deterministic containment matrix against candidate workers;
- prove original source and reference repositories remain unchanged.

C-10:

- hash the complete stable source tree, active runtime tree, stable task state, stable sessions, and stable evidence before and after;
- prove candidate cannot mutate them;
- prove no push, merge, deploy, active replacement, or self-promotion occurred.

### 7.5 One uninterrupted pack

Run C-01 through C-10 from one immutable candidate snapshot. A timeout or source mutation fails the pack. Do not replace failed entries with independent reruns.

Production `advanceCandidate()` must call this same implementation. Test-only candidate pack logic and production candidate validation must not diverge.

## 8. Implement executable H-01 through H-11 experiments

The current hypothesis test validates catalog metadata only. It is not experiment evidence.

Add one experiment registry where every H entry defines:

- exact command;
- required environment;
- source snapshot hash;
- expected observations;
- success predicate;
- fallback predicate;
- durable evidence paths;
- linked E2E and AC IDs.

Run all experiments on the final frozen source. Existing E2E evidence may be referenced only when it executes the same experiment and meets every H predicate.

HERDR remains optional. H-09 may remain rejected with the approved OMP handoff fallback if the live HERDR probe cannot be safely confirmed.

## 9. Run the real accelerated long-run proof

Do not mark two repetitions of E2E-01 as long-run mechanics.

Use accelerated clocks and controlled restarts to prove:

- wall-time budget survives restart;
- heartbeat expiry and stale-driver takeover work;
- stale live driver is terminated before replacement;
- run lease renewal covers implementation, verification, review, and candidate stages;
- retry counters survive restart;
- waiting states do not spin a driver loop;
- cancellation remains durable after restart;
- output memory remains bounded while full logs persist;
- logs have an explicit retention or rotation bound;
- no worker, reviewer, driver, verification child, or candidate host leaks after many turns.

Then execute one real unattended fixture workflow with:

- at least two implementation turns;
- at least one verification failure and rerun;
- at least one blocking review and repair;
- two fresh review sessions;
- at least one controlled controller restart;
- at least one controlled worker replacement;
- terminal cleanup.

A literal twelve-hour wait is not required.

## 10. Conformance validator requirements

The validator must derive predicates from the canonical catalog, not merely require filenames and booleans supplied by the runner.

At minimum it must verify:

- required actors;
- required process boundaries;
- required preconditions;
- required observations;
- required evidence files;
- source snapshot identity;
- process PID relationships;
- session identity relationships;
- stage and attempt counts;
- protected root fingerprints;
- cleanup observations;
- candidate pack coherence;
- long-run mechanics.

Specific guards:

- E2E-05 must reject a kill performed after turn completion exists.
- E2E-06 must reject a nonce present in the operator prompt.
- E2E-07 must reject a forbidden write performed by the parent runner or outside the worker containment boundary.
- E2E-08 must reject a killed PID different from the failpoint owner.
- E2E-10 must reject source-tree inspection presented as active-runtime inspection.
- C-04 through C-10 must reject generic happy-path observations.
- Candidate pack validation must reject mixed run IDs, mixed source hashes, and source mutation.

`conformance report valid` must mean that evidence supports the claimed semantics, not only that the JSON structure is internally consistent.

## 11. Final execution order

Execute in this order:

1. preserve current state;
2. fix manifest algorithm and command evidence capture;
3. fix writer CAS, cancellation cleanup, stage-wide lease renewal, turn reconciliation, verification process control, and reviewer attempt identity;
4. rerun unit and adapter suites;
5. rerun E2E-01 and E2E-02;
6. complete E2E-03 through E2E-08;
7. complete E2E-10;
8. freeze stable and candidate snapshots;
9. execute one uninterrupted C-01 through C-10 pack;
10. execute E2E-09 using that pack;
11. execute H-01 through H-11 experiments;
12. execute accelerated long-run mechanics and the substantial unattended workflow;
13. generate report from raw evidence;
14. validate report semantics;
15. generate and independently validate the portable manifest;
16. scan for orphan processes and protected-root mutation;
17. stop at `ready_for_acceptance`.

Do not generate a final report after every intermediate failure. Persist the failure, repair it, and continue while a safe fallback remains.

## 12. Stop conditions

Stop only when one of these conditions is true:

- an operation would commit, push, merge, deploy, promote, or replace active runtime;
- both a preferred implementation and every safe fallback fail with durable evidence;
- a product behavior choice is genuinely absent from the approved contract;
- continuing would risk non-disposable user work and isolation cannot be proved;
- wall-time or retry policy is exhausted.

Do not stop for routine test failures, provider variation, missing fixture code, missing scenario runners, process restart work, candidate API work, sandbox probing, manifest repair, or report repair.

## 13. Required final response

Return:

1. implemented architecture changes;
2. exact H-01 through H-11 verdicts;
3. exact E2E-01 through E2E-10 verdicts;
4. exact C-01 through C-10 verdicts from one coherent pack;
5. long-run mechanics verdict;
6. AC-01 through AC-25 matrix;
7. source, active runtime, stable snapshot, candidate snapshot, archive, manifest file, and tree hashes;
8. command log paths;
9. evidence paths for every PASS and FAIL;
10. remaining blockers;
11. explicit confirmation that no commit, push, merge, deploy, promotion, or active-runtime replacement occurred.

Do not call TCSF complete while `overall` is FAIL.
