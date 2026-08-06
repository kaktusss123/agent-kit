---
description: Full-project baseline security scan (NOT commit-scoped)
agent: security-scan-orchestrator
---

<!-- markdownlint-disable MD041 -->

Run a full-project baseline security scan.

Usage: /security-review [--scope <path>] [--areas <a,b,c>] [--depth quick|standard|deep] [--ref <gitref>] [--force]

$ARGUMENTS

Rules:
- If the workspace is not a git repository, return a short usage hint and stop.
- If `--ref` is omitted, pin to HEAD and record the short hash in the final report.
- Unknown flags should not abort; default to repo root scope, all 10 standard areas, depth `standard`, no `--force`.
- Existing partial reports under `docs/security-report/<run-id>/` are respected unless `--force` overrides them.

Hand the parsed arguments to the `security-scan-orchestrator` agent and continue through the `surface-mapping → parallel scanning → aggregation → final report` workflow.

Area numbers (used by `--areas`):

1. Architecture, entry points, trust boundaries
2. Authentication, sessions, credential handling
3. Authorization, roles, tenant isolation
4. HTTP handlers, input validation, serialization
5. Filesystem, uploads, archives, parsers
6. Outbound HTTP, webhooks, SSRF
7. SQL, shell, templates, code execution
8. Secrets, cryptography, sensitive data
9. Background jobs, queues, race conditions
10. CI/CD, dependencies, deployment configuration