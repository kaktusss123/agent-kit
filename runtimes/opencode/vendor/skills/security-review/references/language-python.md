# Python Security Notes

Load with vulnerability-specific references for Python, Django, Flask, FastAPI, and common Python libraries. These are investigation prompts, not automatic findings.

## Execution and Serialization

Inspect attacker-reachable use of:

- `eval`, `exec`, `compile`, dynamic imports, and plugin paths;
- shell-enabled subprocess APIs or constructed command strings;
- `pickle`, `marshal`, unsafe YAML/object loaders, job payload deserialization;
- template compilation from untrusted strings;
- archive extraction and temporary files.

`subprocess` with an argument list and no shell reduces shell injection, but option/command selection can remain unsafe.

## Web Frameworks

### Django

- ORM filters and parameterized queries are generally structural; inspect `.raw`, `RawSQL`, `.extra`, custom SQL, and dynamic identifiers.
- Templates auto-escape in normal HTML contexts; inspect `safe`, `mark_safe`, autoescape changes, raw HTML, and non-HTML contexts.
- Verify object-level/tenant authorization beyond login decorators.
- Inspect mass assignment through forms/serializers/model updates and fields such as owner, tenant, role, status, and privilege.
- Check CSRF exemptions only on cookie-authenticated state-changing routes and prove exploitability.
- Confirm host/proxy/security settings from actual deployment context before reporting configuration issues.

### Flask/FastAPI

- Trace authentication/authorization dependencies on every alternate route and method.
- Verify Pydantic/schema validation rejects unexpected nested structure where operators or privileged fields matter.
- Check template engine defaults and explicit raw rendering.
- Confirm proxy headers are trusted only behind a verified proxy boundary.

## Files and Paths

Use path-aware containment after normalization/resolution. Inspect symlinks, uploads, `send_file`/static helpers, temp files, and archive extraction. Framework helpers may apply protections; verify their documented behavior and actual arguments.

## Requests and URLs

For SSRF, trace complete URL construction, redirects, proxies, authentication headers, DNS/IP validation, and whether a user-controlled path can replace authority. Configured service base URLs are not attacker-controlled by default.

## Cryptography and Tokens

- Use `secrets` or maintained cryptographic APIs for security randomness.
- `random` is acceptable for non-security sampling/simulation.
- A hash such as MD5/SHA-1 is not automatically vulnerable when used only as a checksum/cache key.
- Verify token claims and purpose through the actual library configuration, not only decode calls.
- Disabled TLS verification is significant only on a sensitive, attacker-interceptable path.

## Async, Jobs, and Transactions

Check whether identity/tenant context is lost when enqueuing jobs, whether retries duplicate effects, and whether database transactions cover both decision and mutation. In-process locks do not coordinate multiple workers/processes.

## Common False Positives

- ORM parameterization for values;
- normal Django template interpolation;
- environment/config values treated as attacker input without a mutation path;
- `yaml.safe_load` or data-only parsers used correctly;
- test-only fixtures and development commands not production-reachable.
