# Finding Verification and False-Positive Control

Load this reference before reporting any candidate vulnerability.

## Restate the Claim

Write one precise sentence internally:

> An attacker with [capability] can provide or influence [trigger] through [entrypoint], causing [security decision/sink] without [required control], resulting in [impact].

If this cannot be stated coherently, the candidate is not ready.

Record:

- alleged root cause;
- exact trigger and representation;
- attacker prerequisite;
- affected asset and security property;
- scoped change that introduced/exposed it;
- expected mitigation and why it does not work.

## Six Mandatory Gates

### Gate 1: Scope Attribution

Prove the issue is introduced, exposed, or materially worsened by the reviewed commit. Compare with the base behavior.

Reject when the issue is unrelated legacy code.

### Gate 2: Attacker Control

Identify the actor and exact controlled value, identity, ordering, timing, file, message, configuration mutation, or dependency response.

Distinguish:

- directly attacker-controlled;
- indirectly controlled through stored data or another user;
- operator/deployment controlled;
- trusted service controlled;
- constant or generated internally.

Reject when the required trigger is not realistically controllable.

### Gate 3: Reachability and Preconditions

Trace from a real entrypoint to the vulnerable operation. Include authentication, role, tenant, feature flag, deployment mode, and state prerequisites.

Authentication may reduce severity but does not negate horizontal or vertical privilege escalation.

Reject unreachable branches, dead code, and impossible values established by real callers/types/schemas.

### Gate 4: Mitigation Search

Search for controls at every layer:

- route/middleware/policy;
- schema/type/parser configuration;
- normalization and canonicalization;
- allowlisting and bounds checks;
- escaping/encoding appropriate to the final context;
- parameter binding;
- transaction/locking/idempotency;
- framework defaults;
- sandbox, OS, network, or deployment policy.

A control counts only when it applies to this path and security property.

### Gate 5: Concrete Impact

State what the attacker gains:

- read or modify another principal's data;
- perform a forbidden action;
- execute code or commands;
- access internal services/credentials;
- forge identity, token, signature, or approval;
- cause durable state/value corruption;
- expose secrets or sensitive data;
- bypass a security-relevant audit or integrity guarantee.

Do not report generic "input validation" without a demonstrated impact.

### Gate 6: Evidence and Reproduction Logic

Provide:

- exact locations;
- source/identity to sink/decision chain;
- relevant preconditions;
- absent or ineffective mitigation;
- a minimal conceptual reproduction or negative test;
- high-confidence explanation.

Do not require an executable exploit. Do require a complete reasoning chain.

## Devil's Advocate Pass

Before finalizing, try to falsify the finding:

- Is the value actually server-controlled?
- Is there upstream validation or downstream encoding?
- Does a framework parameterize or escape this operation?
- Does middleware guarantee identity/tenant state?
- Is the effect inside a rollback-only transaction?
- Is the target already within the attacker's authorized capability?
- Does canonicalization make the alleged bypass impossible?
- Is the risky API used in a non-security context?
- Does the base ref already behave identically?

Document the strongest counterargument and why evidence defeats it.

## Confidence Decision

**High confidence** requires all applicable gates and no unresolved material counterargument.

**Medium confidence** means a key fact is missing, such as deployment policy, cross-service contract, caller constraints, or runtime parser mode. Do not report it as a required fix. Put the exact uncertainty in residual risks, or block when the review contract requires that fact.

**Low confidence** means pattern-only, theoretical, defense-in-depth, or speculative chaining. Omit it.

## Finding Evidence Template

Use this compact structure inside the shared review table:

- `Attacker`: actor and prerequisite.
- `Source/decision input`: exact controlled input or identity fact.
- `Path`: relevant functions and transformations.
- `Sink/effect`: dangerous operation or authorization/state decision.
- `Missing control`: expected protection and evidence it is absent/ineffective.
- `Scoped regression`: changed hunk or removed invariant.
- `Impact`: concrete capability gained.
- `Confidence`: High.

## Remediation Test Template

Require a negative test that:

1. creates the attacker and victim/security boundary;
2. sends the minimal malicious or unauthorized input/sequence;
3. asserts denial, safe encoding, bounded parsing, rollback, or no external effect;
4. verifies the legitimate path still succeeds.
