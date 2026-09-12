# Business Logic, State Machines, and Concurrency

Use for payments, quotas, approvals, inventory, invitations, lifecycle transitions, idempotency, retries, races, and multi-step workflows.

## Start from Invariants

Business-logic vulnerabilities are violations of domain security properties, not suspicious APIs.

Write invariants such as:

- value is transferred exactly once and total debits equal authorized credits;
- an approval can be exercised only by the intended role for the intended object/version;
- a resource cannot move from terminal state back to active without a privileged transition;
- a quota/entitlement is checked and consumed atomically;
- one external event causes at most one durable effect;
- price, amount, recipient, tenant, and currency used at execution are the values authorized earlier.

Then identify attacker-controlled order, repetition, timing, fields, or parallelism that can violate them.

## Workflow Bypass

Check whether an attacker can:

- call a later step directly;
- repeat a one-time action;
- skip approval/payment/verification state;
- change security-relevant fields after approval but before execution;
- reuse an invitation, reset, coupon, nonce, or signed operation;
- exploit alternate endpoints/jobs that enforce fewer states;
- transition from an unexpected or terminal state;
- abuse cancellation/refund/retry ordering.

UI sequence is not enforcement. Verify server-side state and authorization at every sensitive transition.

## Race Conditions and TOCTOU

Prove concurrency feasibility and durable impact.

Trace:

`check/read -> interleaving window -> competing operation -> write/effect -> invariant violation`

Look for:

- balance/quota/inventory check then separate decrement;
- uniqueness check then insert without database constraint;
- authorization/ownership check then resource replacement;
- file check then open with symlink/path race;
- cache lock or in-process mutex used across multiple processes;
- async jobs applying stale state;
- distributed retries without idempotency.

Do not report a theoretical race without a realistic overlapping execution and security impact.

## Transactions, Locks, and Constraints

Verify the actual isolation and scope:

- transaction covers both decision and effect;
- lock targets the right row/resource and is acquired in every path;
- database uniqueness/check constraints support application logic;
- external side effects are coordinated with transaction commit;
- retries do not duplicate non-transactional effects;
- optimistic concurrency checks the expected version and handles failure safely.

## Idempotency and Replay

Check whether idempotency keys are:

- scoped to principal/tenant and operation;
- bound to request semantics;
- persisted atomically with the effect;
- protected from collision/reuse;
- retained for the relevant replay window.

Signature verification does not prevent replay unless freshness or uniqueness is enforced.

## Numeric and Value Integrity

Inspect:

- integer overflow/underflow in relevant languages/configurations;
- sign errors, negative values, rounding, precision, unit/currency mismatch;
- client-controlled price/discount/entitlement;
- partial updates that break aggregate invariants;
- comparison before normalization/conversion;
- limits enforced per request but bypassable through batching/concurrency.

Prove impact and runtime behavior; many languages/libraries handle overflow differently.

## Failure and Recovery

Adversarially model timeouts, partial success, duplicate callbacks, rollback, compensation, and retry. Failures can create authorization or value bugs when the system records success before effect, effect before durable record, or accepts ambiguous provider status.

## Remediation Direction

Enforce explicit state machines, bind approvals/signatures to immutable execution data, use atomic transactions/constraints/locks, implement scoped idempotency and replay protection, validate numeric units/ranges, and test duplicate, reordered, stale, and concurrent requests.
