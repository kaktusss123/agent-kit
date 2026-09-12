# Cheap Writer Safety

## Contents

- Purpose
- Compact checklist
- Typical grep checks

## Purpose

Use this compact checklist whenever a low-cost writer model implements tests.

## Compact checklist

1. `AsyncMock(spec=Interface)` for async dependencies; no bare dependency `AsyncMock()`.
2. `MagicMock(spec=Interface)` only for sync dependencies; never for domain, Pydantic, or protobuf data.
3. Polyfactory-backed factories for reusable entities, commands, and mapper inputs.
4. Real system under test with mocked dependencies; never mock the SUT or its method under test.
5. Module-level test functions by default; classes require explicit plan approval.
6. Test names describe behavior; one-line test docstrings are allowed only for clarification.
7. One behavior per test; mapper and validator tests may assert one output object's fields.
8. `assert result is not None` must be paired with behavior assertions.
9. Config changes use `monkeypatch` or `try/finally` restoration.
10. Skips always include `reason=`.
11. Reusable factories and fixtures are not defined directly in `test_*.py` files.
12. If Polyfactory is absent, add it to dev or test dependencies before adding reusable model factories.
13. Do not chase coverage with standalone runtime-type assertions for trivial wrappers or ID generators.
14. Do not reference temporary agent artifacts in committed tests or skip reasons.
15. Keep imports at module level; do not interleave imports with test logic.
16. Use Faker, Polyfactory, and parametrization for arbitrary and boundary data.
17. Avoid boilerplate module docstrings such as `"""Tests for ..."""`.
18. Keep testcontainers behind `--real-db`; default test commands use in-memory backends.
19. Prefer one backend-agnostic integration test body for behavior that should match across in-memory and real DB backends.
20. When dual-backend parity is in scope, rerun the same integration selection with `uv run pytest --real-db -m integration` or an equivalent project-specific command.
21. Reserve `real_db` and `migration` markers for PostgreSQL-specific semantics and migration coverage.
22. For narrow coverage, prefer path-based `--cov=package/subpackage` over dotted `--cov=package.subpackage`.
23. Use `coverage run` only when the repository config is compatible with `PyTracer`, or when a dedicated compatible coverage config is provided.
24. Prefer `uv run ruff check <changed-scope> --fix` for autofixable lint issues; use `--unsafe-fixes` only after a safety review.
25. Verify repository-wide invariants across the whole target tree, not only changed files.
26. Do not refactor tests on a red relevant baseline; repair first or stop as blocked.
27. Rerun exact regression sets after repairs and during final verification.
28. Update stale comments, docstrings, helper names, and labels in touched files immediately.

## Typical grep checks

Use project-appropriate content search to audit changed tests for:

- bare `AsyncMock()` without `spec=`;
- `MagicMock()` used as test data instead of dependency mocks;
- `class Test` introductions without plan approval;
- direct `config.` assignment without restoration;
- inline imports in `test_*` functions;
- skip reasons mentioning `docs/agent-testing`, `plan-`, `capsule`, `writer-report`, or `review-report`;
- hard-coded `test-*`, static IPs, versions, and namespaces where generated data is more appropriate.
