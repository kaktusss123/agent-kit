# JavaScript and TypeScript Security Notes

Load with vulnerability-specific references for Node.js, Express-like servers, React/Vue/Angular/Next-like frameworks, and browser code.

## Server-Side Execution

Inspect attacker-reachable use of:

- `eval`, `Function`, VM/sandbox APIs, dynamic import/require paths;
- `child_process.exec` and shell-enabled command construction;
- templating or expression engines compiling untrusted strings;
- unsafe object merge/property assignment enabling prototype pollution;
- filesystem paths, archive extraction, and upload handlers.

Argument-array process APIs reduce shell parsing but still require fixed executable/option structure and validation.

## SQL and NoSQL

Verify actual query API semantics. Parameterize values; allowlist dynamic identifiers/operators. For Mongo-like queries, inspect attacker-controlled objects containing operators, regex, JavaScript expressions, or unexpected nested structure. TypeScript types do not validate runtime input by themselves.

## Browser Rendering

- Normal JSX/framework interpolation is generally escaped.
- Explicit raw HTML features (`dangerouslySetInnerHTML`, `v-html`, direct `innerHTML`-like sinks) require tracing attacker content and sanitizer/context.
- URL-valued attributes/navigation need scheme/origin validation as applicable.
- Server-side rendering and hydration can introduce different contexts; inspect how data is serialized into HTML/script.

## Express and Middleware Ordering

Trace middleware in effective order and route coverage:

- authentication and authorization;
- body parsing and size limits;
- CSRF/session/cookie handling;
- proxy trust and client IP/host derivation;
- error handlers and fallbacks;
- route mounts and method variants.

A middleware exists only as a mitigation if the candidate route passes through it before the effect.

## Object and Prototype Safety

Potential prototype pollution requires:

- attacker-controlled property path/object structure;
- unsafe recursive merge/set/clone behavior;
- ability to write prototype-related keys or equivalent;
- a later security-sensitive property lookup/effect.

Do not report from `Object.assign` or spread alone without the full chain. Use null-prototype maps, schema validation, safe libraries, own-property checks, and explicit field allowlists where needed.

## Tokens, Sessions, and CORS

Verify library settings for signature, issuer, audience, expiry, cookie scope, proxy trust, and origin matching. Decoding a token is not verification. CORS is not authorization, and wildcard policies require a concrete sensitive browser-readable response to establish impact.

## Async and Concurrency

Single-threaded JavaScript still has races across awaits, requests, workers, processes, and distributed services. Trace state read, `await`/external call, competing operation, and write/effect. In-memory locks/caches may not coordinate multiple instances.

## Supply Chain and Build

Inspect new lifecycle scripts, dynamic package loading, untrusted build inputs, source maps/secrets in client bundles, and CI execution of fork code. Do not assert a dependency CVE without evidence.

## Common False Positives

- escaped framework interpolation;
- parameterized ORM/query-builder values;
- constant strings assigned to HTML sinks;
- TypeScript compile-time restrictions assumed to validate runtime input;
- authenticated routes incorrectly dismissed despite object-level authorization gaps.
