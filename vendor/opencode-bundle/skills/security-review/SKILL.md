---
name: security-review
description: "Focused security review for authentication, authorization, secrets, external inputs, privileged operations, persistence, network boundaries, and other security-sensitive changes."
---

# Security review

Build the threat picture from the actual change. Identify protected assets, trust boundaries, attacker-controlled inputs, identity and authorization decisions, privileged side effects, persisted sensitive data, and external systems.

Load only relevant references from this skill's `references/` directory. Use language-specific guidance only for languages present in the reviewed path.

Prioritize plausible attack paths such as authorization bypass, tenant confusion, injection, unsafe parsing, SSRF, path traversal, secret exposure, insecure defaults, replay, race conditions, and fail-open behavior when the code makes them possible.

Do not report a checklist category without a concrete path from attacker capability to impact.

For each real finding, state preconditions, impact, code or design evidence, and the smallest useful correction direction. Separate exploitable defects from hardening suggestions. If no material issue is found, say which trust boundaries and attack paths were checked.
