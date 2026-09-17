# PR/MR description standard

Standardize the information shape, not only the section headings. Related PRs/MRs should be easy to compare side by side.

## Standardization contract

Normalize all of these when evidence and repository conventions allow it:

- title grammar and capitalization;
- language;
- section order;
- summary length and purpose;
- granularity and ordering of change bullets;
- ordering and wording of verification facts;
- what qualifies for `Review notes`.

For sibling PRs/MRs from the same epic, migration, or repeated change pattern, draft them as a set. Reuse the same wording for shared facts when it remains accurate. Put project-specific differences after the shared facts instead of changing the whole structure.

## Title

Follow the repository's established title convention for structure: type prefix, ticket placement, capitalization, closing lines. Titles are in English unless the user explicitly requests otherwise. If the convention uses Conventional Commits with a ticket identifier, prefer this shape:

```text
feat(EVODP-11877): generate public API contract as OpenAPI v3
```

For sibling PRs/MRs, keep the type, ticket placement, verb form, capitalization, and terminology consistent.

Use normal technical casing in prose and titles, such as `public API` and `OpenAPI v3`. Preserve exact casing only for literal package names, commands, identifiers, and paths.

If the repository convention includes a ticket-closing line such as `Closes EVODP-11877`, place it consistently across sibling PRs/MRs. Do not add closing semantics unless they are actually intended.

## Default body

Use this section order:

```markdown
## Summary

<Usually two sentences: what changes, then why it matters or what compatibility is preserved.>

## Changes

- <material change>
- <material change>

## Verification

- [x] <positive verification fact>

## Review notes

- <only when reviewer attention is genuinely useful>
```

`Review notes` is optional. Omit it when there is nothing specific to call out.

Do not add a default `Known issues` section.

## Summary

Default to two concise sentences.

1. State the primary change in behavior, contract, artifact, or system outcome.
2. State why it is being done and, when material, what compatibility or invariant is preserved.

Prefer outcome-level wording. Keep generator versions, command flags, dependency details, cleanup mechanics, and file-by-file implementation details in `Changes` unless one of them is central to understanding the change.

Do not include branch state, rebase status, work-log history, or unrelated environment details.

Example shape:

```text
Migrate the generated public Nessie API contract from Swagger 2.0 JSON to OpenAPI 3.0.3 YAML. The generated contract is ready for technical writers without manual conversion while preserving the existing protobuf and HTTP API surface.
```

## Changes

Use a few meaningful bullets at comparable granularity. Do not narrate the diff file by file.

Prefer this semantic order when the categories exist:

1. Primary implementation or toolchain change.
2. Public behavior, contract, schema, or source annotation changes.
3. Generated artifacts and runtime/package contents.
4. Dependencies, build integration, hooks, or automation required by the change.
5. Project-specific support changes that materially affect review.

For sibling PRs/MRs, keep shared categories in the same order and use parallel wording. Add unique project details after the shared facts.

Prefer verb-led bullets over bold pseudo-headings. Combine tightly related facts instead of producing a long inventory.

Include dependency or repository-hygiene changes only when they are part of the implementation a reviewer should understand. Incidental local cleanup does not belong in the description.

## Verification

Verification is positive-only. Publication readiness is handled before creating the PR/MR.

Include only facts supported by evidence already available from the project workflow. Omit unavailable metrics instead of writing `N/A`, `not run`, `unknown`, skipped checks, or failures.

Use this order when the facts are available:

1. Automated tests.
2. Changed-code coverage.
3. Overall coverage and delta.
4. Build, typecheck, lint, or other repository quality gates.
5. Generation reproducibility or idempotence.
6. Packaging and clean-environment import/install checks.
7. Contract or behavior compatibility checks.
8. Change-specific invariants.

Preferred forms:

```markdown
## Verification

- [x] Automated tests pass: 93 total, 14 added
- [x] Changed-code coverage: 91%
- [x] Overall coverage: 74.2% -> 75.0% (+0.8 pp)
- [x] `go build ./...` passes
- [x] OpenAPI generation is idempotent
- [x] Built wheel contains the generated `openapiv3` modules and imports successfully in a clean environment
- [x] Public HTTP contract is preserved: 10 operations and 4 request bodies
```

If only the pass result is reliably known:

```markdown
- [x] Automated tests pass
```

If the total test count is known but the number added is not:

```markdown
- [x] Automated tests pass: 93 total
```

Never infer `Tests added` from a fragile heuristic. Use it only when the repository or workflow provides a trustworthy count.

Use percentage points for the delta between two coverage percentages. `74.2% -> 75.0%` is `+0.8 pp`, not `+0.8%`.

Prefer outcomes over setup steps. For example, `OpenAPI generation is idempotent` is better than listing `uv sync` followed by two `make gen` invocations.

Keep change-specific checks when they prove something reviewers care about. Exact enum value sets, preserved route forms, UUID example validity, descriptor parity, or artifact imports are valid when relevant. Put them after the common verification items so sibling PRs remain easy to compare.

## Review notes

Use `Review notes` only for facts that change how a reviewer should interpret the diff or deserve deliberate human attention.

Good uses:

- an existing compatibility quirk intentionally preserved;
- a scope exclusion a reviewer is likely to question;
- an external URL or domain fact that needs owner confirmation;
- a deliberate deviation from a reference implementation and the reason for it.

Do not use `Review notes` for:

- failed or unavailable tests;
- dependency or environment problems unrelated to the change;
- branch/rebase status;
- facts already stated in `Changes` or `Verification`;
- unrelated bugs discovered during implementation;
- a second list of implementation details.

If a reference project contains a bug that this change avoids, normally describe the concrete packaging or implementation choice under `Changes`. Mention the reference only when the deviation itself is something reviewers need to evaluate.

## Language and terminology

Write descriptions in Russian by default. Use another language only when the user explicitly requests it for a specific PR/MR, repository, or organization. Repository language conventions do not override this default. Title language is covered by the title rules: English unless the user explicitly requests otherwise.

For sibling PRs/MRs, use one language across the set: titles in English, descriptions in Russian or the explicitly requested language.

Keep exact command names, file names, versions, identifiers, paths, and measured numbers when they materially help review. Use one term consistently for the same concept throughout the description.

## Final normalization pass

Before returning or publishing a draft:

1. Compare sibling PRs/MRs side by side when available.
2. Align title grammar, terminology, summary shape, bullet granularity, and verification order.
3. Remove work-log details and repeated facts.
4. Keep unique project facts, but place them in the same semantic position as comparable facts in sibling PRs/MRs.
5. Remove `Review notes` entirely if every remaining note is informational rather than review-relevant.
