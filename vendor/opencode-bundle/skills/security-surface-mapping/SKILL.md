---
name: security-surface-mapping
description: "Build a project-wide security surface map for a baseline scan: technology stack, entry points, trust boundaries, and relevance-based file-set allocation across 10 security scan areas. Used when the security-scan-orchestrator dispatches mapping before parallel scanners."
---

# Security Surface Mapping

Produce a project-wide attack-surface map that downstream security scanners consume as their per-area scope. Not a vulnerability report. Mapper output drives scanner handoff context.

Pre-load `repo-reconnaissance` for evidence discipline, file-location methodology, and evidence-vs-inference phrasing. Apply its rules here.

## Non-Negotiable Invariants

- Map surfaces by repository evidence, not filename guessing. Quote the file(s) that justify each model claim.
- Do not invent technologies, dependencies, or entry points absent from manifests (`package.json`, `go.mod`, `pyproject.toml`, `pom.xml`, `Cargo.toml`, `*.csproj`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`).
- Use the three-level evidence phrasing from `repo-reconnaissance`: "Repository evidence suggests...", "This appears likely, but could not be fully confirmed...", "No direct evidence was found for...".
- Never embed actual secrets, tokens, private keys, or personal data in the map. Redact with `***REDACTED***` while retaining enough structure to mark the location for downstream redaction.
- Do not edit source files. Write only to `docs/security-report/<run-id>/surface-map.md`.
- Do not delegate. Do not report vulnerabilities — that is the scanner's job. Mapper stays surface-level.

## Workflow

### 1. Resolve Run Context

Confirm from the handoff:
- run id (folder name under `docs/security-report/`);
- pinned ref (short hash) — call `git rev-parse --short <ref>` via permitted read-only git commands;
- scope path filter (default repo root);
- depth mode (`quick | standard | deep`);
- requested area list (default: all 10 standard areas).

If any are missing, return `needs_more_context` with a missing-items list.

### 2. Project Manifest

Inspect manifests and configuration at the pinned ref. Record:

| Element | Where to find |
|---|---|
| languages and runtimes | `package.json`, `go.mod`, `pyproject.toml`, `requirements.txt`, `pom.xml`, `build.gradle`, `Cargo.toml`, `*.csproj`, `pubspec.yaml`, `Gemfile` |
| frameworks | imports and usage in entry files; common ones by name detection |
| significant libraries | dependency manifests + lock files; flag security-relevant ones (auth, crypto, parsing, web, queue, ORM, templating) |
| runtime and deployment | `Dockerfile`, `docker-compose.yml`, `k8s/*.yaml`, `*.tf`, `.github/workflows/*.yml`, `Makefile`, scripts |
| build and test tooling | linters, typecheckers, test runners, formatters |

This manifest section must be embedded verbatim into every downstream scanner handoff context (the orchestrator copies it).

### 3. Trust Boundaries and Entry Points

Reuse the model template from `skills/security-review/references/context-and-trust-boundaries.md`:

| Layer | Items |
|---|---|
| Actors | anonymous user, authenticated user, tenant admin, system admin, service account, worker, operator, external service, LLM/tool agent |
| Assets | credentials, tenant data, money/value, PII, source artifacts, signing keys, deployment authority, audit records |
| Entrypoints | HTTP/RPC handlers, message consumers, scheduled jobs, CLI inputs, webhooks, file uploads, callbacks, plugin/MCP-style tools, parsers |
| Trust boundaries | browser/server, tenant/tenant, user/admin, service/service, control plane/data plane, repo/CI, model/tool, app/OS |
| Security decisions | auth, authZ, tenant scoping, validation, policy, signature verification, approval, rate/accounting |
| Sensitive effects | state changes, external calls, file writes, code execution, secret access, signing, deployment, audit emission |

Cite the file(s) where each detected entry point or boundary lives. Missing items become explicit unknowns.

### 4. Relevance-Based Area Allocation

Map 10 areas. **Allocations are relevance-based, NOT disjoint.** Overlap across areas is expected and desirable — the same file may be scanned by multiple agents focused on different vulnerability patterns. Each area gets its own file set based on patterns relevant to that area.

For each area, output:

| Field | Description |
|---|---|
| Area number and name | canonical identifier |
| Relevance indicator | security patterns to look for in this area |
| Allocated file set | paths where these patterns appear, with `file:line` anchors where known |
| References to load | one or more files under `skills/security-review/references/` to load |
| Language references | mandatory one or more `references/language-*.md` based on stack |
| Cross-area reference points | entry/handler locations that also need attention in another area; flag clearly so scanners coordinate without duplicating FINDINGS |
| Est. scope | small / medium / large relative to repo |

Area catalog (canonical — do not renumber or rename):

| # | Area name | Primary reference(s) |
|---|---|---|
| 1 | Architecture, entry points, trust boundaries | `context-and-trust-boundaries.md` |
| 2 | Authentication, sessions, credential handling | `authentication-and-session.md` |
| 3 | Authorization, roles, tenant isolation | `authorization-and-tenancy.md` |
| 4 | HTTP handlers, input validation, serialization | `requests-files-and-parsers.md` (validation/serialization focus) |
| 5 | Filesystem, uploads, archives, parsers | `requests-files-and-parsers.md` (filesystem/parser focus) |
| 6 | Outbound HTTP, webhooks, SSRF | `requests-files-and-parsers.md` (outbound focus) |
| 7 | SQL, shell, templates, code execution | `injection-and-code-execution.md` |
| 8 | Secrets, cryptography, sensitive data | `secrets-crypto-and-data.md` |
| 9 | Background jobs, queues, race conditions | `business-logic-and-concurrency.md` |
| 10 | CI/CD, dependencies, deployment configuration | `configuration-ci-and-supply-chain.md` |

Optional areas (include only when appropriate to the stack):

| Area | Trigger | Reference |
|---|---|---|
| LLM agents, tool calls, prompt injection | Code invokes LLM tools, RAG, MCP-style integrations | `agentic-and-prompt-injection.md` |
| Native code, unsafe memory, FFI | Rust/C/C++/Go unsafe, FFI bindings, integer/lifetime hazards | `memory-safety-and-native-code.md` |
| Browser render, redirects, CORS, CSRF, postMessage | Browser-rendered JS code handling user data or redirects | `web-client-security.md` |

### 5. Likely-Secret Locations for Redaction Guidance

List paths the scanners should treat as secret-bearing and redact aggressively in their report:

- `*.env`, `*.env.*` (except `*.env.example`)
- `*.key`, `*.secret`, `*.pem`, `*.p12`
- files containing literals matching `password`, `token`, `apiKey`, `secret`, `private_key`
- placeholders that look real

Explicit `***REDACTED***` rules:
- Strip the value, preserve the structural hint (e.g., `Authorization: ***REDACTED***`).
- Never paste a hex or base64 blob greater than 32 chars from a secret-looking source.

This is not a secret inventory — only guidance so scanners never leak raw secrets into the final report.

### 6. Depth Mode Adjustments

- `quick`: skip areas estimated "large" if no clear high-risk indicator; mention skipped areas.
- `standard`: include all 10 areas; allocate at file granularity.
- `deep`: include all 10 + optional areas; allocate at `file:line` precision; cite at least one piece of evidence per allocated set.

### 7. Mapping Gaps and Unknowns

Apply `repo-reconnaissance` evidence discipline. List explicitly:

- areas estimated as effectively empty (file set is empty) — flagged "N/A — no allocated surface";
- areas where mapper could not fully resolve the allocated set due to ambiguity;
- missing manifests or runtime docs that would change allocation.

### 8. Output Artifact

Write `docs/security-report/<run-id>/surface-map.md`:

```markdown
# Security Surface Map

Run id: <run-id>
Pinned ref: <short hash>
Scope: <path or repo root>
Depth: quick|standard|deep
Requested areas: <list or all>

## 1. Project Manifest
(languages, frameworks, libraries, runtime, deployment)

## 2. Trust Boundaries and Entry Points
(actors / assets / entrypoints / trust boundaries / security decisions / sensitive effects)

## 3. Area Allocations

### Area 1 — Architecture, entry points, trust boundaries
- Relevance indicators: ...
- Allocated file set: ...
- References to load: ...
- Language references: ...
- Cross-area reference points: ...
- Estimate: small|medium|large

(repeat for each requested area)

## 4. Likely-Secret Locations for Redaction
(paths and patterns)

## 5. Mapping Gaps and Unknowns
(explicit list)
```

## Handoff

Return to the orchestrator a structured summary containing: the artifact path, the project manifest verbatim (so the orchestrator can copy it into every scanner handoff), the list of allocated areas with their estimates, and any blocked/unknown areas so the orchestrator can route them.