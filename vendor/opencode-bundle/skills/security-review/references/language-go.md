# Go Security Notes

Load with vulnerability-specific references for Go services, CLIs, parsers, templates, and concurrent code.

## Commands and Processes

`exec.Command(name, args...)` does not invoke a shell by default, which mitigates shell metacharacter injection. Still inspect attacker control of executable name, arguments/options, environment, working directory, PATH resolution, and whether a shell is explicitly invoked.

## SQL and Templates

- Use database placeholders/arguments for values; inspect constructed query strings and dynamic identifiers.
- `html/template` performs contextual escaping; `text/template` does not provide HTML safety.
- Types such as `template.HTML`, `template.JS`, or similar trusted-content wrappers bypass escaping and require provenance review.

## HTTP and URLs

For SSRF, inspect parsed URL, redirects, proxy environment, DNS/IP resolution, forwarded credentials, and transport configuration. Confirm server timeouts and body limits only when availability impact is within review scope.

For proxy/header trust, verify trusted proxy boundaries before using forwarded host/scheme/IP for authentication, redirects, or policy.

## Files and Archives

Use cleaned/resolved path containment with path-aware comparisons. Inspect symlinks, temporary file permissions, archive entry names/links, and writes followed by execution/loading.

## JSON and Struct Binding

Review over-posting into structs that include privileged fields, ambiguous duplicate/case-insensitive fields where library behavior matters, custom unmarshalling hooks, and unbounded nested input where security-relevant.

Plain JSON decoding is not code execution. Trace the later use.

## Cryptography

Use `crypto/rand` for security randomness, maintained crypto/TLS APIs, and explicit verification of signatures/claims. `math/rand` is fine for non-security uses. Check nonce uniqueness, key purpose, and TLS verification configuration in the actual transport.

## Concurrency

Go makes concurrency common. For candidate races, inspect:

- shared maps/state without appropriate synchronization;
- check-then-act across goroutines or requests;
- lock scope and copied mutexes;
- channel close/send ownership;
- context cancellation and partial effects;
- database transactions versus in-memory mutexes;
- retries and duplicate messages.

A data race warning is not enough; establish a security invariant violation.

## Errors and Zero Values

Check ignored errors around authentication, signature verification, parsing, random generation, file permissions, and transactions. Determine whether zero values cause fail-open behavior. Not every ignored error is security-relevant.

## Common False Positives

- `exec.Command` argument arrays mistaken for shell execution;
- `html/template` normal interpolation flagged as XSS;
- `math/rand` used only for tests/sampling;
- server-controlled config mistaken for attacker input;
- goroutines labeled vulnerable without a feasible interleaving and impact.
