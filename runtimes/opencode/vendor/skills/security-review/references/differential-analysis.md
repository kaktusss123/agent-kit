# Differential Security Analysis

Use this reference for commit/PR review, especially for security-sensitive refactors, removed checks, changed defaults, or unclear historical intent.

## 1. Inventory Behavioral Change

Classify each changed hunk by effect:

- new or removed entrypoint;
- changed authentication or authorization condition;
- changed validation, normalization, escaping, or parsing;
- changed identity, tenant, ownership, or role propagation;
- changed external request, callback, command, or file path;
- changed secret, key, token, randomness, or certificate handling;
- changed transaction, retry, idempotency, or concurrency behavior;
- changed default, feature flag, deployment, dependency, or CI permission;
- moved logic where ordering or middleware coverage may differ.

Do not equate syntactic size with security impact.

## 2. Compare Security Invariants

For each high-risk hunk, state:

- invariant before the change;
- invariant intended after the change;
- evidence that every old enforcement path has an equivalent new enforcement path;
- newly reachable states or callers.

Refactors require proof of invariant preservation.

## 3. Inspect History Selectively

Use history when:

- a guard, allowlist, escaping step, signature check, or permission check was removed or weakened;
- code has comments such as security, exploit, CVE, workaround, compatibility, or do not reorder;
- the diff reverses an older fix;
- a default becomes permissive;
- a privileged helper becomes public or gains new callers.

Ask:

- Why was the old code introduced?
- Was it part of a bug or security fix?
- Does the new implementation preserve the original constraint?
- Is the current change reintroducing a previously closed path?

History is evidence, not authority. Old code can also be wrong.

## 4. Estimate Blast Radius

For a changed high-risk function, policy, schema, or helper, inspect:

- direct callers;
- public or privileged callers;
- indirect callers through wrappers, interfaces, callbacks, routes, jobs, or dependency injection;
- data schemas and persisted state shared by other flows;
- cross-tenant or cross-service consumers;
- feature flags and defaults controlling rollout.

Describe blast radius qualitatively when exact counting is impractical:

- local: one endpoint or internal flow;
- component: several callers in one service;
- systemic: shared policy, parser, library, identity layer, CI template, or persisted format.

Do not raise severity merely because blast radius is large; combine it with exploitability and impact.

## 5. Review Tests as Evidence

Look for tests that establish security properties, not only happy paths:

- unauthorized actor and wrong-tenant access;
- malformed, encoded, boundary, and alternate-representation input;
- replay, duplicate, stale, reordered, and concurrent operations;
- failure of external dependencies;
- migration and backward-compatibility paths;
- negative tests for removed or changed guards.

Missing tests reduce confidence in the change. They are not a vulnerability without a broken production path.

## 6. Scope Attribution Gate

Before reporting, answer:

- Which scoped hunk introduced or exposed the issue?
- Would the same exploit succeed at the base ref?
- If the root cause predates the commit, what exactly became newly reachable or more impactful?

Do not report unrelated legacy issues.

## High-Risk Regression Signals

- `deny` becomes `allow`, or missing value becomes permissive.
- object-scoped query becomes global lookup.
- server-derived identity becomes request-derived identity.
- canonicalization or validation moves after the security decision.
- check and effect move into different transactions/jobs.
- signature verification no longer binds all security-relevant fields.
- safe parser mode changes to generic/default mode.
- pinned action/dependency becomes floating or executes untrusted code with secrets.
- error handling converts explicit denial into fallback success.
