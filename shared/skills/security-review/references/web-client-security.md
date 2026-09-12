# Web Client Security

Use for HTML/template rendering, DOM manipulation, redirects, browser messaging, CORS, CSRF, URL handling, and client-side trust decisions.

## Cross-Site Scripting

Prove:

`attacker-controlled value -> rendered or DOM context -> missing/wrong contextual encoding or unsafe HTML interpretation -> script-capable result`

Different contexts require different controls: HTML text, attribute, URL, JavaScript string/code, CSS, and raw HTML are not interchangeable.

### Common Risky Paths

- raw HTML APIs with attacker-controlled content;
- template auto-escaping disabled or bypassed;
- untrusted URL inserted into executable navigation/resource context;
- server-generated JSON embedded unsafely into script;
- DOM sources such as location, message, storage, or server data reaching HTML/script sinks;
- sanitizer output used in a context it was not designed for.

### Framework Mitigations

Normal interpolation in many modern frameworks is escaped, while explicit raw-HTML features are not. Confirm the exact framework, version, rendering mode, sanitizer, and context before reporting.

A constant assigned to an HTML sink is not XSS. Stored database content may still be attacker-controlled if another principal can write it.

## CSRF

Review state-changing operations authenticated by ambient browser credentials such as cookies or client certificates.

Verify:

- anti-CSRF token/origin checks or a robust same-site design;
- unsafe methods do not mutate state;
- CORS does not replace CSRF protection;
- login, logout, account linking, email change, key creation, and sensitive workflow transitions receive appropriate protection;
- JSON/content-type assumptions cannot be bypassed through alternate encodings or simple requests.

If authorization uses an explicit bearer token not automatically attached cross-site, classic CSRF may not apply. Prove browser behavior.

## CORS

CORS is a browser read-access policy, not server-side authorization.

High-risk conditions require a concrete sensitive response and attacker origin capability, for example:

- reflecting arbitrary origins while allowing credentials;
- broad trusted-origin matching with suffix/prefix confusion;
- trusting `null` or attacker-controlled subdomains contrary to the threat model;
- exposing sensitive unauthenticated data cross-origin.

Wildcard origin without credentials is not automatically a vulnerability; evaluate the protected resource and browser credential model.

## Redirects and URL Navigation

For open redirect, prove attacker control of the destination and a security-relevant consequence such as OAuth token leakage, trusted-domain phishing in a sensitive flow, or redirect-based policy bypass. Generic redirects may be low impact under the shared rubric.

Prefer relative paths or strict origin/route allowlists. Parse and canonicalize once; reject ambiguous schemes, userinfo, encoded separators, and protocol-relative forms as applicable.

## postMessage and Cross-Window Communication

Check both sides:

- sender uses a specific target origin for sensitive data;
- receiver validates `event.origin` exactly and, where relevant, `event.source`;
- message schema and action are validated;
- messages do not directly drive privileged DOM or application actions.

## Client-Side Authorization

Hidden buttons, route guards, disabled controls, and client claims are not security boundaries. Confirm the server enforces the same action/resource policy.

## Remediation Direction

Use contextual output encoding, safe framework interpolation, narrowly configured sanitization for intentional HTML, server-side authorization, robust CSRF defenses, exact origin validation, and browser-focused negative tests.
