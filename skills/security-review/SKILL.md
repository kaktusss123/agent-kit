---
name: security-review
description: "Focused security review lens for code changes, designs, authentication and authorization flows, secret handling, external inputs, privileged operations, network boundaries, and persistence. Use when: security risk is materially present or explicitly requested; you need concrete trust boundaries and attack paths with evidence-backed findings instead of checklist noise. Not for: ordinary low-risk edits; use skill://code-review."
---

# Security review

Review the concrete security properties of the requested change or design. Do not run this lens mechanically on ordinary low-risk edits.

## Build the threat picture

Identify the assets worth protecting, trust boundaries crossed by the change, attacker-controlled inputs, authentication and authorization decisions, privileged side effects, persisted sensitive data, and external systems involved.

Trace real control and data flow before judging the implementation. Use `skill://system-understanding` or `skill://blast-radius` when the relevant path is not obvious.

## Check plausible attack paths

Prioritize mechanisms that fit the actual change, including:
- authorization bypass, confused-deputy behavior, tenant or identity mix-ups;
- injection into command, query, template, path, parser, or protocol boundaries;
- unsafe deserialization or parsing assumptions;
- SSRF, open redirects, or unintended network reachability;
- path traversal and filesystem boundary violations;
- secret or credential exposure in code, logs, errors, config, or artifacts;
- insecure defaults, privilege expansion, missing validation at trust boundaries;
- replay, race, retry, or state-transition bugs with security impact;
- weak failure behavior that silently grants access or skips enforcement.

Do not report a category merely because it appears on a checklist. Show the concrete path from attacker capability to impact.

## Evidence and severity

For each real finding, state the vulnerable behavior, preconditions, likely impact, evidence in the code or design, and the smallest useful correction direction. Distinguish exploitable defects from hardening suggestions.

Use authoritative primary documentation through `skill://engineering-research` when the verdict depends on external security semantics, protocol requirements, or library behavior.

## References

Load only what the change touches; do not load all references by default.

- Trust boundaries, attacker capabilities: `references/context-and-trust-boundaries.md`.
- Injection, execution, auth, session, tenancy, secrets, crypto, parsing, network: the matching `references/<topic>.md` (injection-and-code-execution, authentication-and-session, authorization-and-tenancy, secrets-crypto-and-data, requests-files-and-parsers).
- Language-specific pitfalls: the matching `references/language-<name>.md`.
- Comparing against a reference implementation: `references/differential-analysis.md`.
- Agent/tool prompt-injection shape: `references/agentic-and-prompt-injection.md`.

Before reporting a vulnerability, read `references/finding-verification.md` and verify the finding the way it requires.

If no material issue is found, say so and name the trust boundaries or attack paths that were actually checked.
