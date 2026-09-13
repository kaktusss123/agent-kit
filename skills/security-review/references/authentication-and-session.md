# Authentication and Session Security

Use for login, identity proofing, password reset, MFA, sessions, cookies, API keys, OAuth/OIDC/SAML, JWT-like tokens, and service identity.

## Security Properties

Verify that the system binds one authenticated identity to the intended principal, session, audience, purpose, and lifetime; prevents replay or fixation where required; and fails closed on invalid or ambiguous identity evidence.

## Review Questions

### Credential Verification

- Is the credential compared using the intended verifier and current account identity?
- Can alternate login paths bypass disabled/locked/deleted account checks?
- Are password reset, email change, MFA recovery, and invite acceptance treated as authentication flows?
- Does error handling or fallback convert verification failure into success?
- Can an untrusted upstream assert identity without cryptographic or channel binding?

### Sessions and Cookies

- Is the session identifier unpredictable and regenerated after authentication or privilege elevation?
- Are logout, password reset, account disablement, and sensitive changes reflected in session validity?
- Are cookie scope and attributes appropriate to the deployment: `Secure`, `HttpOnly`, `SameSite`, domain, path, and lifetime?
- Can attacker-supplied session identifiers be adopted (fixation)?
- Can session data be modified without integrity protection?

Cookie flags are context-dependent. Missing flags are not automatically high severity; prove an attack path.

### Tokens

Verify:

- signature/MAC validation occurs before claims are trusted;
- algorithm/key selection cannot be attacker-confused;
- issuer, audience, subject, purpose, expiry, not-before, and nonce/state are checked as applicable;
- key identifiers cannot trigger arbitrary file/network lookup or unsafe key selection;
- tokens for one environment, tenant, client, or purpose are not accepted in another;
- revocation/version checks exist when immediate invalidation is a stated property;
- sensitive one-time tokens are single-use and bound to the intended action.

Do not flag a token format merely because it is readable; confidentiality and integrity are different properties.

### OAuth/OIDC/SAML and Federated Identity

Trace:

- authorization response to the initiating browser/session using state/nonce or equivalent;
- redirect URI/client binding;
- issuer and audience validation;
- identity mapping and account linking;
- handling of duplicate/changed email addresses and unverified attributes;
- privilege/tenant mapping from external claims;
- logout and deprovisioning behavior.

High-risk patterns include account linking based only on mutable email and accepting identity claims from an unintended issuer/client.

### Password and Secret Storage

- Passwords should use a dedicated adaptive password hashing construction with per-password salt and appropriate parameters.
- API keys/reset tokens stored server-side should be protected according to retrieval needs; verification-only tokens can often be stored as hashes.
- Do not report weak hash usage when it is clearly a non-security checksum, cache key, or content fingerprint.

## Common Vulnerability Paths

- password reset token not bound to account/purpose or reusable;
- MFA check performed only in UI or one login endpoint;
- session remains privileged after role/account changes contrary to requirements;
- token validates signature but not issuer/audience/purpose;
- attacker controls algorithm, key source, or identity mapping;
- service trusts a spoofable header outside a verified proxy boundary;
- fallback authentication activates on verifier error;
- enumeration meaningfully aids a demonstrated takeover path.

## False-Positive Checks

- Confirm framework/session middleware behavior and deployment configuration.
- Confirm the apparent credential is not a public client identifier.
- Confirm an authenticated route is still unauthorized for the attacker before calling it a bypass.
- Confirm token claims are not validated centrally outside the changed function.

## Remediation Direction

Prefer centralized verification, explicit issuer/audience/purpose binding, single-use stateful transitions, session regeneration, fail-closed errors, and tests for alternate authentication paths and stale/replayed credentials.
