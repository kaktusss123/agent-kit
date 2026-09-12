# Context and Trust Boundaries

Load this reference when a security-relevant path spans multiple functions, modules, services, queues, storage layers, or privilege domains.

## Build the Model Before Naming Vulnerabilities

Record a compact model:

1. **Actors**: anonymous user, authenticated user, tenant admin, system admin, service account, worker, operator, compromised dependency, external service.
2. **Assets**: credentials, tenant data, money/value, personal data, source artifacts, signing keys, deployment authority, audit records.
3. **Entrypoints**: HTTP/RPC handlers, message consumers, scheduled jobs, CLI inputs, file imports, webhooks, callbacks, deserializers, plugin/tool invocations.
4. **Trust boundaries**: browser/server, tenant/tenant, user/admin, service/service, control plane/data plane, repository/CI, model/tool, application/OS.
5. **Security decisions**: authentication, authorization, tenant scoping, validation, policy evaluation, signature verification, approval, rate/accounting transitions.
6. **Sensitive effects**: state changes, external calls, file writes, code execution, secret access, signing, deployment, notification, audit emission.

## Per-Function Context Card

For each non-trivial function on a candidate path, identify:

- purpose and caller expectations;
- explicit inputs and implicit inputs such as identity, configuration, process environment, shared state, current transaction, and time;
- preconditions and type/schema constraints;
- reads, writes, returns, exceptions, and external interactions;
- invariants established, consumed, or assumed;
- privilege before and after execution;
- whether failures are fail-closed, fail-open, retried, or ignored.

Do not mechanically analyze every line. Go deep where a trust boundary or invariant is crossed.

## Continuous Flow Rule

Treat a call chain as one continuous execution path:

`entrypoint -> middleware -> handler -> service -> policy -> data layer -> external effect`

Carry forward:

- attacker control;
- validation facts;
- identity and tenant facts;
- encoding/context facts;
- transaction and concurrency facts;
- privilege and capability facts.

Do not reset assumptions at function boundaries.

## External Calls

When code is available, inspect the relevant target path.

When code is unavailable, model the dependency as adversarial or fallible unless a verified contract says otherwise. Consider:

- timeout, error, malformed response, and partial success;
- replay, duplicate delivery, reordering, and stale response;
- unexpected redirects or callback targets;
- compromised or confused identity;
- return values outside assumed ranges;
- reentrancy/callback effects where applicable.

Do not invent behavior. Mark contract uncertainty as residual risk when it affects the verdict.

## Invariant Reconstruction

Write security invariants as falsifiable statements, for example:

- A user can mutate an invoice only when the invoice tenant equals the active tenant and the user has `invoice.write`.
- A reset token is single-use, bound to one account and purpose, expires, and is compared in constant time where relevant.
- An artifact is deployed only after the exact artifact digest is approved.
- A webhook side effect is applied at most once for one provider event identifier.

Then locate every enforcement point and every path that bypasses it.

## Fragility Indicators

Increase scrutiny when you see:

- the same policy implemented in several handlers;
- identity or tenant passed as ordinary caller-controlled parameters;
- checks separated from effects by async boundaries or transactions;
- implicit ordering dependencies;
- broad exception handling around security checks;
- cached authorization without clear invalidation;
- shared mutable state across tenants or requests;
- privileged helpers callable from both trusted and untrusted paths.

## Anti-Hallucination Rules

- Replace "probably" with a named missing fact.
- Correct earlier assumptions when evidence contradicts them.
- Distinguish observed code behavior from inferred deployment behavior.
- Cite exact locations for critical assumptions.
- Stop the candidate when any required attack-path link is disproven.
