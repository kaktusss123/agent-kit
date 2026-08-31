# TCSF Operations

## Configure

Set `TCSF_HOME` to the durable root when a non-default location is required. The default is `~/.omp/tcsf`. The extension is loaded from the active `extensions/tcsf` tree and uses isolated sessions under `<TCSF_HOME>/sessions`.

## Start and inspect

1. Produce an approved contract packet with immutable artifact hashes, repository base SHAs, acceptance commands, and task policy.
2. Run `/tcsf_run /absolute/path/to/packet.json` to import the packet and start its durable driver, or run `/tcsf_run <task-id>` for an already imported task.
3. Run `/tcsf_status <task-id>` to inspect the persisted task phase and active run stage.
4. Run `/tcsf_resume <task-id>` after a stopped or lost driver. Resume is recovery, not a second concurrent writer.

A run is ready for human acceptance only when candidate validation passes. Run `/tcsf_accept <task-id>` explicitly; acceptance is not inferred from a passing implementation or review.

## Foreground handoff

`/tcsf_attach <execution-id>` acquires an operator writer lease and prints a command to resume the exact OMP session plus a continuity nonce. Do not start an independent session in the same worktree. Return control with `/tcsf_return <execution-id> <continuity-nonce>`; the factory verifies the nonce before releasing the handoff state. Use `/tcsf_resume <task-id>` if the autonomous driver must be restarted.

## Decisions and safety

Critical decisions must include evidence paths, at least two concrete options, a recommendation, delay consequences, and a resume stage. A decision request is written under the run decision artifacts before publication. `/tcsf_decide` is intentionally conservative until an authorized resolution payload is available; use the decision tool or an integration that supplies a validated `DecisionResolution`.

Verification commands run in the prepared worktree. Their complete stdout/stderr is written to run artifacts while returned output is bounded. A nonzero result fails unless the command declares another expected exit code. Unauthorized changes to protected repositories or files outside the approved worktree scope are restored when possible and fail the run rather than being silently accepted.

## Recovery evidence

Inspect these artifacts when diagnosing a stopped run:

- `tasks/<task-id>/task.json`
- `tasks/<task-id>/runs/<run-id>/run.json`
- `tasks/<task-id>/runs/<run-id>/driver-identity.json`
- `tasks/<task-id>/runs/<run-id>/driver-events.jsonl`
- `tasks/<task-id>/runs/<run-id>/verification/`
- `tasks/<task-id>/runs/<run-id>/review/`

Do not edit task or run JSON by hand while a driver is active. Stop the driver, preserve the artifacts, and resume only after the workspace and lease state are understood.
