---
name: engineering-research
description: >-
  Resolves uncertain engineering facts from authoritative primary sources and
  exact-version documentation. Use when APIs, frameworks, dependencies,
  standards, runtime behavior, configuration, or protocol semantics must be
  verified rather than inferred from model knowledge.
---

# Engineering research

Resolve engineering facts from the strongest source available. Combine exact local evidence with authoritative external documentation; neither a generic documentation lookup nor model memory is sufficient when version, runtime, or protocol details affect the answer.

## When to use

Use this skill when the answer or implementation depends on:

- an API, framework, SDK, CLI, library, or configuration option;
- version-specific behavior, breaking changes, or compatibility;
- a protocol, standard, security semantic, or runtime guarantee;
- an external dependency whose exact behavior is not established by the attached repository.

Do not use it for ordinary repository code discovery when the behavior can be established by reading the repository itself. Use `skill://system-understanding` or `skill://blast-radius` for those repository-internal questions when appropriate.

## Research workflow

### 1. Define the question

State the exact fact that must be resolved. Record the target version, runtime, platform, flags, environment assumptions, and the engineering decision the answer will affect.

### 2. Check exact local evidence first

For software behavior, prefer this order:

1. installed or vendored exact version;
2. lockfiles, generated API descriptions, and repository tests;
3. source, tag, or release matching that version;
4. official documentation or specification for that version;
5. upstream current source when version-specific material is unavailable;
6. secondary sources only for leads or community experience.

Distinguish a public supported API or guarantee from an internal implementation detail. Do not substitute current documentation for the target version without saying so.

### 3. Retrieve documentation deliberately

For external library and platform documentation, use the strongest available primary source. In OpenCode, Context7 is the standard lookup path for indexed library documentation:

```bash
npx ctx7@latest library <name> <specific-query>
npx ctx7@latest docs <library-id> <specific-query>
```

Resolve the library ID first unless the user already supplied a Context7 ID in the form `/org/project` or `/org/project/version`. Use a version-specific ID when the question names a version. Make queries specific enough to identify the API, behavior, or migration question, and never put secrets or proprietary code in them.

Use no more than three Context7 lookup attempts for one question. If Context7 is unavailable or its quota is exhausted, state that limitation and use the best available official source rather than silently presenting unverified current knowledge as exact.

### 4. Reconcile the evidence

Follow important claims back to the source that owns them. If sources disagree, preserve the disagreement, identify which source governs the target environment, and explain why. Record dates and version boundaries when they can change the result.

## Output

Return:

- the answer to the exact question;
- evidence links or repository/source pointers for material claims;
- versions, dates, flags, and environment assumptions that matter;
- confidence and limitations, including unavailable or conflicting sources;
- the concrete implication for the engineering decision.

Do not require a background agent. The current agent may research directly or delegate when the host provides a useful mechanism.
