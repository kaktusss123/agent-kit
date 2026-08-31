# TCSF corrective validation and completion directive

## Status and authority

The current implementation is an unaccepted candidate checkpoint. Preserve it and continue from it. Do not discard or rewrite working code merely because the previous acceptance report was rejected.

`TCSF_IMPLEMENTATION_SPEC.md` remains the normative architecture and implementation contract. This directive does not weaken or replace that specification. It resolves the current report defects, selects the already authorized reviewer fallback, and defines the evidence required for a new acceptance decision.

The current candidate is not complete and must not be described as production-ready, accepted, or autonomous for twelve-hour operation until the mandatory runtime scenarios pass.

Work autonomously. Do not ask the user about routine implementation, testing, provider prompting, result parsing, process management, fixture design, or repair. Ask only when every architecture-preserving fallback in this directive and the normative specification has failed, or when a real critical semantic decision is unavoidable.

Do not push, merge, deploy, promote, accept, or replace protected branches. Do not install or modify HERDR. Do not add compatibility normalization for the observed reviewer response unless a later human decision explicitly authorizes it.

## Architectural decisions made for this corrective pass

1. The current implementation is rejected as a final TCSF delivery but retained as the implementation candidate.
2. Removing a globally callable `tcsf_review_result` tool is provisionally accepted as a security improvement. The replacement must still prove session binding, single submission, strict schema validation, read-only reviewer behavior, and resistance to cross-session forgery.
3. The reviewer protocol remains the normative TCSF `ReviewResult` schema:

```ts
interface ReviewResult {
  verdict: "pass" | "fail" | "decision_required";
  summary: string;
  findings: ReviewFinding[];
}
```

4. The observed shape below is not an approved compatibility format:

```json
{
  "status": "blocked",
  "findings": [
    {
      "criterionId": "...",
      "message": "..."
    }
  ]
}
```

It is not losslessly equivalent to the TCSF contract. It omits required semantics such as summary, evidence, violated invariant or criterion, severity, and expected correction. Do not silently invent those fields.
5. Apply the H-08 fallback already approved in the specification: strict final JSON parsing followed by exactly one protocol-repair turn in the same reviewer session. Only after the bound result channel and this fallback both fail repeatedly may H-08 become `BLOCKED` and require a human architecture decision.
6. HERDR remains optional and outside the main path. A failed HERDR probe is acceptable only after the OMP same-session handoff fallback passes.
7. The full candidate scenario pack C-01 through C-10 is mandatory for self-development acceptance. A loader smoke test is not candidate validation.
8. The foreground continuity E2E is mandatory for final acceptance. It may use a real interactive OMP client driven through a safe PTY or another public interface. It must not copy a summary into a new session.
9. Copying candidate files into `~/.omp/agent/extensions/tcsf` is an active test installation, even if no Git push or merge occurred. Treat it as a mutable test installation that requires a fingerprint, snapshot, and rollback path. Do not call it a non-deployment without qualification.

## Phase 0: freeze and preserve the current candidate

Do this before editing more code or running destructive process tests.

1. Record the repository root, current branch, HEAD, all worktrees, and complete `git status --porcelain=v2`.
2. Record every tracked modification and untracked implementation file under the TCSF source, skills, agents, docs, tests, and the temporary specification file.
3. Create a durable candidate snapshot outside `/tmp` and outside product repositories. Include:
   - `git diff --binary` for tracked changes;
   - a tar archive of all untracked candidate files;
   - SHA-256 hashes and sizes for every included file;
   - repository HEAD and status;
   - source TCSF tree hash;
   - active runtime TCSF tree hash;
   - installed OMP and Bun versions;
   - the exact source-to-active synchronization command previously used.
4. Locate any pre-candidate active-runtime snapshot or backup. Record its hash and an exact rollback command. If no prior snapshot exists, say so explicitly and create a snapshot of the current active runtime before continuing. Do not claim that rollback to the previous accepted runtime is possible when it is not.
5. Find the earlier H-01 through H-11 JSON files. Copy them and all raw logs from the temporary directory into a durable acceptance run directory. Preserve the original bytes. If they no longer exist, record evidence loss and rerun the probes later.
6. Choose one durable acceptance root, outside `/tmp`, for this pass. Suggested layout:

```text
<TCSF_ACCEPTANCE_ROOT>/
  baseline/
  snapshots/
  reports/
    hypotheses/H-01.json ... H-11.json
    contracts/
    e2e/E2E-01/ ... E2E-10/
    candidate/C-01/ ... C-10/
    long-run/
    acceptance.json
  raw-logs/
```

7. Do not create a Git commit unless the user has separately authorized commits. The durable snapshot must make the untracked implementation recoverable without a commit.

Exit criteria:

- the current candidate can be reconstructed byte-for-byte;
- the active runtime can at least be restored to the captured current state;
- no acceptance evidence exists only in `/tmp`;
- all later report entries can reference durable paths.

## Phase 1: repair the conformance ledger before repairing production behavior

The previous report assigned the wrong meanings to several hypothesis IDs. This is a correctness defect in the evidence system, not merely a wording issue.

Create one canonical machine-readable catalog used by probes, tests, and report generation. Each entry must contain at least `id`, `title`, a stable definition hash, required experiment, success conditions, fallback, and linked acceptance criteria. Generate the final hypothesis table from this catalog rather than from model memory.

Use these exact hypothesis identities:

```text
H-01 OMP RPC supports durable multi-turn sessions
H-02 OMP RPC exposes enough lifecycle and cancellation data
H-03 Same-session foreground handoff works
H-04 Current ctx.newSession can be isolated as an interactive adapter
H-05 Unexpected OMP UI requests can be handled or rejected
H-06 Candidate runtime can be isolated from stable runtime
H-07 OMP tool hooks can enforce session-bound write policy
H-08 Structured reviewer result is reliable
H-09 HERDR can provide live OMP foregrounding on this machine
H-10 Legacy task runtime can coexist read-only during migration
H-11 Managed run driver outlives the initiating OMP session
```

The previous mappings are invalid. In particular:

- multi-turn continuity belongs primarily to H-01, not H-02;
- H-02 requires normal completion, tool activity, cancellation, and unexpected transport death to be classified without parsing prose;
- candidate isolation is H-06;
- legacy coexistence is H-10;
- driver survival after the initiating OMP session exits is H-11.

Allowed hypothesis verdicts are exactly:

```text
CONFIRMED
REJECTED_WITH_FALLBACK
BLOCKED
```

`REJECTED_WITH_FALLBACK` is legal only after the fallback itself has passed its required experiment. A proposed or coded fallback is insufficient. If a preferred path fails and its fallback is unexecuted or fails, use `BLOCKED`.

Add a test that fails report generation when:

- an ID is paired with the wrong canonical title or definition hash;
- an evidence file is missing;
- a verdict is outside the allowed set;
- `REJECTED_WITH_FALLBACK` lacks successful fallback evidence;
- a downstream adapter depends on a `BLOCKED` or pending capability.

Acceptance results must use exactly `PASS` or `FAIL`. Do not use `PARTIAL`. An unexecuted runtime criterion is `FAIL`, even if code for it exists.

## Phase 2: audit the current implementation and previous claims

Before changing production code, inspect the current implementation against the canonical catalog and the normative specification.

Produce a provisional ledger that separates:

```text
implemented but unexecuted
executed with durable evidence
executed only with temporary or missing evidence
failed
not implemented
```

Do not infer runtime behavior from TypeScript compilation, source inspection, unit tests, a model statement, or a loader smoke test.

At minimum, correct the previous report as follows unless new durable evidence proves otherwise:

- H-01 may remain `CONFIRMED` only if the durable evidence proves process restart and resume of the same persisted history with a nonce and terminal lifecycle events.
- H-02 is not confirmed by a two-turn smoke. It requires the full lifecycle and cancellation experiment.
- H-03 is not `REJECTED_WITH_FALLBACK` until real same-session OMP handoff passes.
- H-04 cannot rely on the H-03 fallback until that fallback passes.
- H-05 requires a real or protocol-faithful invisible UI request test plus timeout or deterministic rejection evidence.
- H-06 requires stable fingerprints, candidate loading, a fixture workflow, isolated state, and post-run fingerprint comparison. Loader registration alone is insufficient.
- H-07 requires the specified adversarial writes. If pre-tool hooks cannot guard a tool, disable that direct mutation tool in autonomous mode and prove the post-turn integrity fallback.
- H-08 remains blocked until the corrective protocol work below passes.
- H-09 can use OMP handoff only after H-03 passes.
- H-10 requires representative legacy manifests to remain unchanged and unconsumed.
- H-11 requires actual initiating OMP termination, continued run progress, duplicate driver rejection, driver death, replacement through `tcsf_resume`, and no duplicate stage effects.

Also audit the statement that the source was applied to the active runtime. Identify exactly which stable or previous files were replaced. Preserve their backups. If the candidate modified the only running evaluator before candidate isolation was proven, record that as a bootstrap limitation and do not claim AC-20 yet.

## Phase 3: resolve H-08 without asking the user

Treat the incompatible reviewer response as a protocol investigation, not as a provider-choice question.

### 3.1 Capture the effective reviewer execution

For the failed fixture and a fresh reproduction, persist:

- model and provider identifiers;
- OMP version and invocation;
- role or agent name selected by TCSF;
- exact skill files and instructions loaded;
- exact bootstrap prompt or its hashed artifact reference;
- available tool names and permissions;
- session directory and opaque session reference;
- cwd and read-only roots;
- raw RPC frames and lifecycle events;
- raw assistant output before any parsing;
- parser error and repair counter;
- whether any old, built-in, archived, or stale reviewer contract was loaded.

Determine whether the response came from:

- a TCSF-owned reviewer prompt using the wrong schema;
- an OMP built-in reviewer role with its own output contract;
- stale active skill bytes;
- a provider structured-output transformation;
- final prose because the bound result channel was unavailable;
- another concrete cause supported by evidence.

Do not blame the model or provider without proving the effective prompt and channel were correct.

### 3.2 Preferred reviewer result paths

Try these paths in order. Stop at the first path that passes its complete contract suite.

#### Path A: bound per-execution result channel

Use a result channel that is created or authorized for one reviewer execution and one review attempt. It must enforce:

- the caller is the bound reviewer session or execution;
- the active run is in the expected review stage;
- the submission token or binding is single-use and cannot be replayed;
- exactly one valid result is accepted;
- missing, malformed, duplicate, stale, cross-run, cross-session, and post-stage submissions fail closed;
- reviewer prose cannot override the accepted structured result;
- the reviewer has no product write authority.

Do not consider a globally visible tool unsafe merely because it is visible if the runtime can prove the caller binding before accepting data. Conversely, hiding a tool name is not authorization.

#### Path B: public structured output support

If the installed public OMP RPC or SDK API supports a schema-constrained output path, use it only after an installed-version probe. Validate the returned value again inside TCSF. Do not depend on undocumented internals.

#### Path C: strict final JSON with one repair turn

This is the pre-approved H-08 fallback.

1. Parse only one complete JSON value from the reviewer result according to a documented framing rule.
2. Validate it against the exact TCSF schema with unknown-field and required-field policy made explicit.
3. On failure, send one repair message to the same logical reviewer session. Include the validation errors and exact schema. Tell the reviewer to return only the corrected JSON object and not to repeat the review.
4. Parse and validate once more.
5. If the second result is invalid or missing, end the review attempt as a protocol failure. Do not normalize it and do not treat prose as a verdict.

### 3.3 Adversarial reviewer protocol suite

Run all of these cases for the selected path:

```text
valid pass
valid fail with one complete blocking finding
valid decision_required
missing result
malformed JSON
JSON in a code fence when framing forbids it
unknown verdict
missing summary
missing required finding evidence
fail with no blocking finding
multiple JSON objects
duplicate submission
stale submission from an earlier review round
submission by the implementer session
submission by an unrelated reviewer session
submission after the run has left review stage
valid structured result followed by contradictory prose
first malformed result followed by valid same-session repair
first malformed result followed by a second malformed result
```

Persist the result of every case. Only one valid bound result may affect workflow state.

### 3.4 Fresh reviewer and read-only proof

For each review round prove:

- a new logical reviewer session ID is used;
- the approved contract, actual Git diff, deterministic verification evidence, and resolved prior findings were provided;
- no writable worktree root or mutation tool is available, or attempted writes are denied before mutation;
- original and worktree fingerprints remain unchanged by the reviewer;
- the reviewer session cannot submit a result for another execution.

H-08 is `CONFIRMED` if a preferred bound or public structured path passes. It is `REJECTED_WITH_FALLBACK` if the strict final JSON plus one repair turn passes. It is `BLOCKED` only if all permitted paths fail with durable raw evidence.

Do not ask the user to choose a reviewer strategy during this phase.

## Phase 4: complete unit and port contract coverage

The earlier result of eight tests and twenty-four assertions is not evidence for the test surface required by the specification.

Add or locate deterministic tests for every required item, including:

- all allowed and forbidden task and run state transitions;
- no direct transition to accepted or completed from an agent result;
- optimistic revision conflicts;
- run and writer lease conflicts, expiry, stale-owner recovery, and token validation;
- event append, replay, and crash-safe partial-write behavior;
- atomic artifact replacement and revision conflict;
- retry counters by failure class and persistence across restart;
- wall-time budget and heartbeat expiry across restart;
- critical semantic decision classification;
- operator blocker classification;
- packet and artifact hash validation;
- path traversal, canonicalization, symlink escape, duplicate canonical repositories, and repo-key collisions;
- worktree planning by primary, target, and reference role;
- dirty repository preflight and safe refusal;
- protected repository fingerprints for tracked, untracked, HEAD, branch, and symlink changes;
- safe restoration that cannot erase pre-existing user work;
- verification cwd, exit code, bounded inline output, and durable full output;
- review schema and protocol cases from Phase 3;
- adapter selection from canonical probe results;
- cancellation and transport failure classification;
- legacy manifests remain read-only and unmodified;
- report generation rejects mislabeled IDs and evidence-free PASS results.

Run the same contract suite against fake and real selected adapters where applicable.

Agent runtime contract:

```text
create
multi-turn
resume after close and process restart
terminal event
tool activity visibility
cancellation
transport failure
opaque serializable session reference
```

Execution host contract:

```text
start and inspect
writer lease exclusivity before input is sent
graceful stop
forced stop
foreground capability report
lost-host detection
replacement host behavior
```

Artifact store contract:

```text
atomic write
revision conflict
crash-safe append
path escape rejection
```

A test name and count are not enough. Persist the command, exit code, full log path, versions, and test list.

## Phase 5: rerun H-01 through H-11 with correct identities

Rerun each hypothesis in an isolated repository and isolated session or TCSF root. Store each result at the durable acceptance root as `reports/hypotheses/H-XX.json`.

Every result must include:

```text
canonical hypothesis ID and title
definition hash
claim and prior evidence
installed versions
exact command or public API calls
cwd and relevant sanitized environment
fixture paths
start and finish timestamps
PIDs and process start tokens where relevant
opaque session and execution references
raw log artifact references
observed output
verdict
selected fallback and its result
downstream consequences
linked ACs
```

Specific requirements that must not be shortened:

- H-02 must classify normal completion, a tool-using turn, explicit cancellation of a long turn, and unexpected process death without parsing human prose.
- H-03 must perform headless nonce turn, safe writer release, real interactive resume of the same session, an interactive turn, autonomous reacquisition, nonce and history verification, and concurrent writer denial.
- H-05 must show that an unexpected UI request cannot wait forever invisibly.
- H-06 must run a fixture workflow under candidate code and compare stable runtime and state fingerprints before and after.
- H-07 fallback must include direct edit or write denial when those tools cannot be safely guarded, plus Git and filesystem detection and safe restoration for Bash mutation.
- H-10 must test representative legacy state bytes before and after.
- H-11 must terminate both the initiating OMP session and later the driver, then prove single ownership and replacement recovery.

## Phase 6: mandatory real E2E suite

Execute E2E-01 through E2E-10 from the normative specification. Do not substitute unit tests or a fake runtime for the scenarios marked real.

For every scenario create a directory containing:

```text
scenario.json
commands.jsonl
events.jsonl
manifest-before.json
manifest-after.json
session-refs.json
processes.json
repository-fingerprints-before.json
repository-fingerprints-after.json
stdout.log
stderr.log
verdict.json
```

Sanitize secrets but preserve enough data to reproduce the run.

Required scenarios:

```text
E2E-01 autonomous approved task reaches ready_for_acceptance after initiating UI exits
E2E-02 deterministic verification failure repairs in the same logical implementer session
E2E-03 semantic defect passes tests, fresh reviewer rejects it, same implementer repairs it, fresh reviewer passes
E2E-04 critical decision persists, controller exits, decision resolves, run resumes without repeating completed work
E2E-05 worker host dies and a replacement resumes the same logical session without duplicate prompt
E2E-06 foreground handoff preserves nonce and session identity, denies concurrent writer, and returns control
E2E-07 unauthorized writes through direct tools, Bash, traversal, and symlink escape are denied or safely detected and restored
E2E-08 controller dies after verification and reconciliation advances exactly once
E2E-09 stable parent evaluates an isolated candidate self-change and ends at ready_for_acceptance
E2E-10 one active TCSF registration, no active V2 terminology, legacy content remains historical
```

Run E2E-01 first after H-08 is repaired. A reviewer pass must be caused by a real validated result, not a test stub.

E2E-02 and E2E-03 must record the same implementer logical session reference before and after repair. E2E-03 must record a different reviewer session for each review round.

E2E-04 must distinguish `waiting_for_decision` from `waiting_for_operator` and prove that a waiting state does not spin an active process loop.

E2E-05 and E2E-08 must prove idempotency through event and stage identifiers, not merely through the final state.

E2E-06 must use a nonce known only to the pre-handoff history. Do not place the nonce in a bootstrap message for a replacement session. A copied summary fails the scenario.

E2E-07 must begin from clean protected fixture repositories. If restoration cannot be proven safe, fail closed and retain the fixture for inspection.

## Phase 7: complete the candidate scenario pack C-01 through C-10

Implement and run the complete pack:

```text
C-01 extension loads exactly once
C-02 expected commands and tools are registered
C-03 approved fixture task runs without an existing interactive session
C-04 verification failure returns to the same logical implementer session
C-05 fresh reviewer rejects a seeded semantic defect and the repair loop corrects it
C-06 critical decision persists, pauses, resolves, and resumes after process restart
C-07 worker process death resumes the same logical session
C-08 foreground handoff preserves session continuity
C-09 protected source and reference repositories remain unchanged
C-10 stable runtime files and state remain unchanged
```

A loader test satisfies only C-01 and part of C-02.

The parent evaluator must be immutable for the duration of the candidate run. Record its bundle hash and state fingerprint before candidate launch and after candidate completion. The candidate must not write parent reports, parent manifests, active runtime files, or parent session storage except through a narrowly defined result transport controlled by the parent.

Because the current candidate has already been copied into the active runtime, explicitly describe the bootstrap boundary:

- If a pre-candidate accepted runtime snapshot exists, restore or use it as the stable parent.
- If no pre-candidate TCSF exists, build an immutable pinned evaluator bundle before making the harmless N+1 candidate change. Mark it as a provisional bootstrap parent. This can prove the isolation mechanism, but it does not by itself grant human acceptance to the current candidate.
- Do not let the candidate grade itself by reading only its own final message. The parent must inspect events, hashes, Git state, exit codes, and result schemas.

AC-20 remains `FAIL` until this complete stable-parent or explicitly documented bootstrap-parent experiment passes.

## Phase 8: long-run mechanics and unattended workflow

Use accelerated clocks and controlled process restarts to prove:

- the twelve-hour wall-time budget persists across controller restart;
- heartbeat expiry detects a lost driver or host;
- retry counters persist and remain bounded;
- waiting states do not consume an active busy loop;
- logs remain bounded while full output is stored in artifacts;
- repeated turns do not leak child processes, descriptors, worktrees, session locks, or leases;
- cancellation leaves a recoverable or terminal durable state;
- stale processes cannot reacquire ownership after replacement.

Then run at least one real unattended fixture long enough to include multiple model turns and at least one repair or review round. The initiating OMP UI must be closed or terminated after launch. Record resource usage and process inventory before and after. The goal is not twelve hours of wall-clock waiting. The goal is evidence that the mechanisms needed for a twelve-hour run survive time, retries, and restarts.

## Phase 9: active runtime verification and rollback discipline

Run all source-level, isolated adapter, and candidate tests before copying new bytes into the active runtime.

Before each active runtime synchronization:

1. fingerprint active files and state;
2. create a rollback snapshot;
3. record the exact synchronization command;
4. verify source and active hashes after synchronization;
5. run the active loader and command registration checks;
6. on failure, restore the snapshot and verify restoration hashes.

Do not call active synchronization a promotion. Promotion still requires the user to accept the final evidence.

Do not delete the legacy archive or old state. Verify that TCSF does not interpret it as current state.

## Phase 10: independent final audit

After all implementation and tests finish, launch a fresh read-only audit session that did not implement the changes. Give it:

- the normative specification;
- this directive;
- the canonical conformance catalog;
- the actual Git diff and untracked snapshot manifest;
- all hypothesis reports;
- all contract test logs;
- E2E-01 through E2E-10 evidence;
- C-01 through C-10 evidence;
- active runtime fingerprints and rollback evidence.

The auditor must check evidence references and report mismatched IDs, missing scenarios, unsupported PASS claims, unsafe restoration, reviewer protocol weaknesses, and stable or candidate boundary violations. Its prose is advisory. The deterministic report validator still decides whether the evidence set is complete.

Fix blocking findings within the existing bounded repair policy, rerun affected checks, and use a fresh auditor for the next round.

## Final reporting contract

Return the exact sections required by `TCSF_IMPLEMENTATION_SPEC.md`.

For hypotheses:

- use only `CONFIRMED`, `REJECTED_WITH_FALLBACK`, or `BLOCKED`;
- use the canonical title beside every ID;
- include durable evidence paths;
- include the selected fallback and downstream consequences.

For acceptance criteria:

- use only `PASS` or `FAIL`;
- every `PASS` must link to concrete durable evidence;
- code inspection alone is acceptable only for a criterion that is purely static;
- any mandatory unexecuted scenario makes its linked criterion `FAIL`;
- do not use `PARTIAL`.

Also include:

- exact source and active runtime hashes;
- the candidate snapshot path;
- the rollback snapshot and command;
- all commands and exit codes;
- exact test counts grouped by unit, port contract, integration, real E2E, candidate pack, and long-run simulation;
- the real reviewer model, role, session, selected result path, and H-08 verdict;
- a table mapping E2E-01 through E2E-10 and C-01 through C-10 to evidence paths;
- a list of remaining failures, not generic risks.

Do not claim completion while AC-03, AC-04, AC-05, AC-07, AC-08, AC-11, AC-17, AC-20, or AC-25 is unexecuted or failed. These criteria cover the defining autonomous, recoverable, foregroundable, independently reviewed, self-development behavior of TCSF.

## Stop and escalation rules

Continue independent work whenever one scenario is blocked.

Stop and request a human decision only when one of these is true:

- all permitted H-08 result paths fail after the specified repair attempt;
- same-session foreground handoff cannot be performed through any documented OMP resume path without losing history;
- candidate isolation cannot prevent mutation of the parent runtime or state through any approved fallback;
- safe repository restoration cannot preserve pre-existing user changes;
- no managed driver or acceptable development fallback can establish single ownership and recoverability;
- a required test would perform an irreversible action outside isolated fixtures;
- the approved architecture itself must change.

An escalation must contain exact evidence, the failed preferred path and every attempted fallback, concrete options, a recommendation, and the effect of each option on named TCSF invariants and acceptance criteria.
