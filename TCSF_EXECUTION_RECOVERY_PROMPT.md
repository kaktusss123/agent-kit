# TCSF execution recovery directive

You are continuing the existing TCSF candidate. This is an implementation and runtime-recovery pass, not another conformance-reporting pass.

Read these files completely before editing:

- `TCSF_IMPLEMENTATION_SPEC.md`
- `TCSF_CORRECTIVE_VALIDATION_PROMPT.md`
- the current TCSF source under `dot_omp/private_agent/extensions/tcsf/`
- the durable acceptance artifacts under `~/.omp/tcsf-acceptance-20260830/`

The current candidate is not accepted. Preserve it and improve it. Do not restart from scratch.

## Operating rule

Continue autonomously until the mandatory runtime scenarios pass or a genuine escalation condition from the normative specification occurs.

The following work is already authorized and must not be escalated to the user:

- diagnosing and repairing E2E-01 through E2E-10;
- implementing and running C-01 through C-10;
- heartbeat, restart, retry, cancellation, and worker-replacement tests;
- H-08 adversarial and cross-session validation;
- changes to adapters, driver logic, fixtures, test harnesses, and evidence collectors needed to satisfy the approved architecture;
- selecting a fixture repository, deterministic test commands, timeouts, and local model configuration;
- replacing an invalid implementation approach with the documented fallback.

HERDR remains optional. A blocked HERDR probe must not block TCSF if same-session OMP handoff can satisfy the contract.

Do not ask for permission merely because a test is long, a scenario failed, or more code is required. Do not stop after producing an honest FAIL report. A truthful report is required, but it is not the goal of this pass.

## Evidence discipline

Do not create empty scenario directories or placeholder `FAIL: Not executed` packs.

Create a scenario evidence directory only when the scenario actually starts. Every attempted scenario must retain:

- the exact runner source or command script;
- timestamps;
- stdout and stderr;
- process identities;
- run, task, execution, session, lease, and workspace manifests;
- event log excerpts;
- Git state and fingerprints before and after;
- timeout or failure classification;
- cleanup result;
- the code revision and configuration used.

Nothing needed to reproduce or audit a result may exist only under `/tmp`.

Do not generate the final acceptance report until all runnable scenarios have been attempted after the relevant repairs. Acceptance verdicts must come from deterministic report code that validates evidence existence and content. A nonempty evidence path alone is not proof.

## First task: investigate the E2E-01 timeout

The prior attempt ran `/tmp/tcsf-e2e.ts`, timed out after 180 seconds, and did not preserve the harness. Treat this as evidence loss.

1. Recover that script if it still exists. Otherwise recreate an equivalent harness inside the repository under a durable test or scenario directory.
2. Reproduce E2E-01 with stage-level tracing and bounded per-operation timeouts. Do not wait blindly for one outer 180-second timeout.
3. Record which operation hangs: driver claim, RPC ready, agent turn, verification, review, decision handling, or cleanup.
4. Fix the root cause, rerun E2E-01, and retain both failed and successful evidence.
5. Only then move to the remaining scenarios.

## Required implementation repairs

Validate each claim against the code before changing it. The items below are suspected defects found during audit. If a claim is false, record the contrary evidence and continue with the actual defect.

### 1. Driver ownership and recovery

Inspect `adapters/local-run-driver-host.ts`, `run-driver-process.ts`, and `app/factory.ts`.

Required behavior:

- Claim the driver atomically before spawning or make child startup tolerate manifest creation order without a race.
- Prevent two drivers from owning one run through an exclusive claim or compare-and-swap protocol.
- Validate and renew the persisted run lease during every state transition.
- Reject stale revisions instead of overwriting `run.json` blindly.
- Heartbeat while a long agent or verification operation is running, not only between stages.
- Reconcile a dead driver without replaying a completed side effect.
- Use monotonic durable event identities suitable for replay and idempotency.
- Remove the fixed 256-iteration busy loop or justify it with a tested scheduler contract.

Add deterministic tests for concurrent start, stale takeover, heartbeat expiry, crash between side effect and state save, and duplicate resume.

### 2. Agent runtime lifecycle

Inspect `adapters/omp/rpc-runtime.ts`.

Required behavior:

- Apply `workspaceRoots`, `readOnlyRoots`, role, model, and session policy rather than accepting and ignoring them.
- Decide explicitly whether child sessions load the TCSF skill and safety extension. Do not combine `--no-extensions --no-skills --no-rules` with claims that those policies protect the worker.
- Add bounded timeouts for a complete model turn, RPC silence, and process exit.
- Capture enough raw or lossless protocol evidence to classify normal completion, tool activity, cancellation, UI requests, and unexpected transport death.
- Reject or handle `extension_ui_request` explicitly. Never ignore it silently.
- Classify agent and tool errors as failures rather than successful terminal turns.
- Preserve a monotonic turn sequence across process restart.

Complete H-02 only after all required lifecycle cases execute.

### 3. Cancellation and process cleanup

`cancelRun` must stop active agent work, verification commands, and the run driver; release leases; persist cancellation once; and reconcile worktrees according to policy.

Verification timeout handling must:

- track whether the timer fired directly;
- terminate the process group, not only the immediate child;
- escalate after a grace period;
- prove that grandchildren do not survive;
- never infer timeout solely from exit code 137 or 143.

Add real process-tree tests.

### 4. Durable decisions

A reviewer `decision_required` result must create a complete durable `DecisionRequest` with evidence, options, recommendation, and continuation metadata before moving to `waiting_for_decision`.

Do not catch all decision-file errors and silently remain waiting. Distinguish missing, corrupt, stale, and invalid requests.

`tcsf_decide` resolves an existing request. It is not the command for an agent to create one. Fix the implementer and reviewer instructions accordingly.

Exercise decision pause, process exit, user resolution, and resume in E2E-04.

### 5. Writer lease and foreground continuity

The current foreground implementation is not accepted by code inspection alone.

Required protocol:

- The autonomous controller owns a persisted writer lease before every `sendTurn`.
- To foreground, it moves the run to an explicit handoff state, stops or detaches its RPC writer, and releases its lease.
- The operator acquires the writer lease before attaching.
- The continuity nonce must already exist inside the logical session history before handoff. Printing it only in attach instructions does not prove session continuity.
- On return, the operator releases the lease durably. The controller reacquires it before resuming.
- Lease release must work after process restart and must not depend on an in-memory map.
- Corrupt lease state must fail closed. Do not delete it and grant a new writer.
- No abandoned RPC process may remain after return.

Prove same-session continuity, single-writer exclusion, restart during handoff, wrong nonce rejection, corrupt lease rejection, and controller reacquisition before marking H-03 or AC-03/AC-06 as passing.

### 6. Reviewer protocol and trust boundary

Keep the exact TCSF JSON schema and one repair turn in the same reviewer session.

Pin and record the effective reviewer model and runtime configuration.

Choose one truthful security model and make code and documentation agree:

- either implement a real bound result channel that checks run, execution, session, stage, freshness, and single-use submission;
- or define the reviewer result as strict final assistant output from a factory-created no-tools session and remove claims about a separate bound submission channel.

Do not keep an in-memory binding map that is never checked.

Run at least the required adversarial cases, including implementer submission, unrelated reviewer, stale result, duplicate result, result after stage transition, malformed JSON, valid JSON plus contradictory prose, protocol repair success, and protocol repair exhaustion.

For `decision_required`, integrate the durable decision flow rather than entering an unrecoverable waiting state.

### 7. Filesystem and Git safety

Inspect `adapters/fs-artifact-store.ts`, `adapters/git-workspace.ts`, and the global tool hook.

Required behavior:

- Defend against symlink and realpath escape, not only lexical `..` traversal.
- Make event persistence crash-safe and replayable; handle partial final JSONL records.
- Recover or classify stale task locks.
- Fingerprint untracked file contents, not only porcelain path text.
- Parse renames and copies correctly.
- Make glob matching segment-aware. `foo/**` must not authorize `foobar`.
- Demonstrate restoration of unauthorized modifications without deleting pre-existing user work.
- Cover Bash and child-runtime writes. A host-only edit/write hook is not sufficient when autonomous workers disable extensions.

Run adversarial write scenarios before marking H-07, AC-15, or AC-16 as passing.

### 8. Candidate isolation

The candidate adapter must do more than load an extension and list commands.

Create an immutable stable-parent bundle and a separate candidate environment with isolated HOME or equivalent OMP/TCSF roots, sessions, artifacts, workspaces, and configuration.

The candidate must not be able to mutate:

- stable source;
- stable active runtime;
- stable run state;
- parent evidence;
- unrelated user repositories.

Run C-01 through C-10. The stable parent, not the candidate, evaluates events, hashes, Git state, exit codes, and acceptance conditions.

Do not call source/active parity proof of correctness. It proves only that identical candidate bytes were copied.

## Scenario order

Use this order unless executed evidence shows another dependency:

1. E2E-01 basic autonomous happy path.
2. E2E-03 verification failure repaired in the same implementer session.
3. E2E-02 semantic reviewer failure repaired, then reviewed by a fresh reviewer.
4. E2E-04 durable critical decision and resume.
5. E2E-05 worker crash and session recovery.
6. E2E-06 controller crash and exactly-once reconciliation.
7. E2E-07 foreground handoff, continuity nonce, and return.
8. E2E-08 unauthorized source-repository write.
9. E2E-09 reference-repository write attempt.
10. E2E-10 cancellation and process-tree cleanup.
11. Long-run heartbeat, restart, and retry scenario.
12. C-01 through C-10 under stable-parent evaluation.

After each failed scenario, classify the failure, repair the smallest responsible layer, rerun that scenario, and run relevant regression tests. Continue to independent scenarios while one external capability remains blocked.

## Reporting

The final report must distinguish:

- `PASS`: the exact criterion executed and durable evidence proves it;
- `FAIL`: an attempted criterion failed after allowed repairs or a required dependency is proven unavailable;
- `NOT_RUN`: only for a true escalation stop that prevents execution.

Do not convert `NOT_RUN` into `FAIL` merely to make a complete-looking table.

Do not mark AC-25 as passing unless the report generator validates every referenced file and the evidence supports the claimed verdict.

Report every code defect found, including defects repaired along the way. Do not describe a port or type declaration as an implemented runtime mechanism unless a real adapter and test exercise it.

## Escalation

Stop for the user only when all documented approaches and safe fallbacks for the same required capability have been executed and failed, and continuing requires one of these actions:

- destructive or irreversible modification outside isolated fixtures;
- access credentials or an external service the environment does not provide;
- a change to the approved product contract rather than an implementation choice;
- promotion, deployment, merge, push, or replacement of a known accepted runtime;
- an unresolved security tradeoff where neither approved option can satisfy the contract.

When escalating, provide the exact failed experiments, evidence paths, two or more viable choices, consequences, and a recommendation. Do not request a blanket authorization to continue routine work.
