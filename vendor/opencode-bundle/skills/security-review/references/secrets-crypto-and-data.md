# Secrets, Cryptography, and Sensitive Data

Use for credentials, API keys, private keys, tokens, randomness, encryption, signatures, password hashing, TLS verification, personal data, and logging.

## Secret Exposure

A secret finding requires evidence that the value is real or plausibly active, sensitive, and introduced/exposed by scope.

High-risk locations include:

- source/config committed with production credentials;
- logs, errors, analytics, traces, URLs, or client responses;
- generated artifacts, build outputs, caches, or CI annotations;
- secrets passed to untrusted processes/actions or fork-controlled code;
- overly broad environment propagation.

Redact evidence. Show only a short prefix/suffix or variable/location. Do not copy complete values into the report.

False-positive candidates include examples, test fixtures, public client IDs, checksums, placeholders, and already-revoked/demo credentials. Verify context.

## Randomness and Tokens

For security tokens, nonces, reset links, API keys, session IDs, salts, and cryptographic keys, verify use of a cryptographically secure generator and sufficient entropy for the threat model.

General-purpose pseudo-random functions may be fine for sampling, UI behavior, tests, shuffling non-sensitive data, or simulation. Prove security use before reporting.

## Password Hashing

Verify dedicated adaptive password hashing rather than fast general-purpose hashes or reversible encryption. Check parameters, per-password salt, migration/rehash behavior, and whether comparison/encoding mistakes bypass verification.

Do not prescribe one algorithm without considering the platform's maintained standard library/framework implementation.

## Encryption and Authenticated Data

Identify the required property:

- confidentiality;
- integrity/authenticity;
- both;
- deterministic lookup;
- password verification;
- non-security checksum.

Check:

- keys are appropriate, separated by purpose, and not attacker-controlled;
- nonce/IV requirements are met and uniqueness is preserved where required;
- ciphertext integrity is verified before plaintext is trusted;
- associated data binds security-relevant context such as tenant, version, purpose, or resource ID;
- errors fail closed and do not expose oracle behavior with practical impact;
- versioning/migration does not silently downgrade.

A weak hash name alone is not a finding when used only for non-adversarial checksums/cache keys.

## Signatures and MACs

Verify the signed bytes bind all security-relevant fields and one canonical representation. Look for:

- omitted amount, recipient, tenant, expiry, algorithm, or purpose;
- ambiguous serialization or duplicate fields;
- verification after using untrusted fields;
- attacker-selected key or algorithm;
- replay due to missing nonce/sequence/expiry/domain separation;
- comparison or parsing that accepts malformed/truncated forms.

## TLS and Certificate Validation

Report disabled certificate/hostname verification only when the path carries sensitive data or authority and an attacker can plausibly intercept/redirect traffic. Check whether a secure transport layer or private channel truly mitigates the path.

## Sensitive Data and Logging

Trace personal, authentication, financial, and tenant data into:

- logs and exception messages;
- analytics/telemetry;
- URLs/query strings/referrers;
- client-side storage;
- caches and shared temporary files;
- cross-tenant exports and debug endpoints.

Consider retention and audience only when evidenced in scope. Avoid policy claims not supplied by acceptance criteria.

## Remediation Direction

Remove/rotate exposed credentials, minimize secret propagation, use platform cryptographic primitives and secure RNG, bind cryptographic context explicitly, validate before use, redact structured logs, and add tests for replay, tampering, wrong tenant/purpose, and invalid certificate paths.
