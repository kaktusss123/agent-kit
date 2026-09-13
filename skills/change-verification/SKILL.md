---
name: change-verification
description: "Fresh-context verification of an implementation checkpoint, usually a commit produced by an orchestrated development slice. Use after a code-changing commit to verify the exact committed state against its intended behavior, run evidence-producing checks, review the diff with relevant lenses, and return PASS or actionable FAIL findings without editing product code."
---

# Change verification

Verify a fixed implementation checkpoint. Do not repair it in the same verification pass.

## Inputs

Establish:
- the commit or exact diff being verified and its base;
- the slice request, specification, or acceptance criteria;
- material repository conventions or policies that govern the change.

If the intended behavior is genuinely unavailable, report a blocker instead of inventing a contract.

## Verify the checkpoint

Inspect the actual committed diff and enough surrounding code to understand its effects.

Use `skill://verification-design` to choose the smallest checks that can observe the requested behavior. Run focused tests, type/lint/build checks, repro scripts, or real integration paths as appropriate. Do not treat a green check as evidence for a requirement it cannot observe.

Use `skill://code-review` for independent review of both intent fidelity and engineering quality. Add specialized lenses only when triggered by the change, for example `skill://blast-radius`, `skill://engineering-research`, or `skill://security-review`.

Repository-specific corporate rules outrank generic preferences when they are explicitly documented.

## Verdict

Return `PASS` only when the committed state satisfies the slice and the available evidence does not expose a blocking defect.

Return `FAIL` with actionable findings when correction is required. Each blocking finding should state:
- the observed behavior or code defect;
- the violated requirement, policy, or engineering invariant;
- concrete evidence such as file/line, failing command, or reproduction;
- the expected correction direction without implementing it.

Separate blocking defects from non-blocking suggestions. Do not manufacture findings for completeness.

## Fresh-context rule

Treat the implementation as a claim, not as something to defend. Do not rely on the implementer's summary when the repository, diff, or executable evidence can answer the question directly.
