---
name: python-test-guide
description: "Use when asked to write, review, or audit pytest tests for a Python service. Covers unit, integration, and architecture tests — when to use each, how to structure them, what patterns to follow."
version: 1.2.0
---

# Python Test Guide

Navigator for writing pytest tests. Load the appropriate reference for the test type you need.

---

## Quick Start

```
User: "напиши тесты для {модуля}"
User: "write unit tests for {module}"
```

### Step 1 — Pick the right reference

| Scenario | Load this |
|----------|-----------|
| Testing a single service/class in isolation | [references/unit-tests.md](references/unit-tests.md) |
| Testing controller → service → repository flow | [references/integration-tests.md](references/integration-tests.md) |
| Enforcing import layering rules | [references/architecture-tests.md](references/architecture-tests.md) |
| Need a specific fixture recipe | [references/fixtures.md](references/fixtures.md) |
| Testing gRPC/protobuf mappers | [references/grpc-protobuf-tests.md](references/grpc-protobuf-tests.md) |
| Setting up a new project's test infra | [references/pytest-config.md](references/pytest-config.md) |
| Reviewing existing tests for quality | [references/antipatterns.md](references/antipatterns.md) |

### Step 2 — Obey the invariant rules

These apply regardless of test type. Violating any of them is a defect.

### R1. Every new module requires tests

Tests are part of the definition of done for any module. A module without tests is incomplete.

### R2. One logical assertion group per test

A test function tests one behaviour. Descriptive names replace docstrings:

```python
# OK
async def test_create_entity_returns_entity_with_generated_id(service, mock_repo):
    ...

# Overloaded — split into separate functions
async def test_entity_service():
    # Creates, updates, lists, and deletes — four concerns
    ...
```

**Exception:** Validator/mapper tests where multiple assertions verify one output object.

### R3. Never mock the system under test

```python
# Service is real, only dependencies are mocked
@pytest.fixture
def entity_service(mock_entity_repository):
    return EntityService(repository=mock_entity_repository)

# Wrong: mocking the service itself
mock_service = AsyncMock(spec=EntityService)
```

### R4. Always use spec= on mocks

```python
# Catches typos at setup time
mock_repo = AsyncMock(spec=EntityRepository)

# Silent attribute creation — typo never caught
mock_repo = AsyncMock()
mock_repo.cretae.return_value = None
```

### R5. tests/integration/ must exist

Even if empty. Signals intent and standardises structure.

### R6. Prefer module-level functions over test classes

```python
# Preferred
async def test_create_entity(service, mock_repo):
    ...

# Acceptable — grouping related tests that share setup
# (architecture tests, parametrized suites)
class TestParsing:
    @pytest.mark.parametrize("input,expected", [("1K", 1024), ("3M", 3_145_728)])
    def test_parse(self, input, expected):
        ...
```

Fixtures replace setUp/tearDown. Classes add nesting without value.

### R7. Config overrides must use try/finally

```python
@pytest.fixture
def feature_enabled():
    original = config.feature.enabled
    try:
        config.feature.enabled = True
        yield
    finally:
        config.feature.enabled = original

# Wrong — state leaks between tests
def test_feature():
    config.feature.enabled = True
```

### R8. Skip with reason

```python
@pytest.mark.skip(reason="Not implemented: inactive entity handling (TICKET-123)")
```

### R9. Reusable fixtures and factories live outside test modules

Reusable test data builders, Polyfactory classes, and pytest fixtures belong in the nearest appropriate `conftest.py` or a dedicated test factory module imported by that `conftest.py`. Do not add reusable `_make_*`, `make_*`, `create_test_*`, or `@pytest.fixture` definitions directly to `test_*.py` files.

**Exception:** a one-off local object setup may stay inside a single test function when it is not reused and does not define a fixture or helper function.

### R10. Polyfactory is the standard reusable factory mechanism

Use Polyfactory for reusable Pydantic/domain model factories. If `polyfactory` is missing from dev/test dependencies, add it there. `model_construct()` is acceptable inside factories or for one-off simple local setup, but it is not the preferred reusable factory API.

### R11. Prefer contract behavior over trivial wrapper coverage

Do not add standalone tests whose only assertion is that a trivial type wrapper, `NewType` constructor, or ID generator returns its underlying runtime type unless that helper is a public boundary contract with a realistic regression risk. Prefer tests where the generated value participates in behavior: entity creation, mapper/serializer output, repository keys, protobuf conversion, or validation.

### R12. Keep committed tests independent from agent artifacts

Committed test code must not reference temporary agent artifacts such as `.tmp/agent-testing`, `plan-*.yaml`, capsule files, writer reports, or reviewer reports. Skip reasons must be self-contained and may reference only stable sources such as product tickets, permanent documentation, or explicit product limitations.

### R13. Keep imports at module level

Place imports at the top of `test_*.py` files. Imports inside test functions are allowed only for explicitly documented exceptional cases such as optional dependency probes or circular-import isolation. Do not interleave imports with arrange/act/assert logic.

### R14. Prefer realistic generated data and parametrized boundaries

Use Faker and Polyfactory for arbitrary strings, names, namespaces, hostnames, IP addresses, versions, and IDs. Keep hard-coded literals only when the literal itself is semantically important, such as `kind="deployment"`. When a field has validation, parsing, serialization, or boundary behavior, cover representative valid and invalid values with `pytest.mark.parametrize`.

### R15. Avoid boilerplate docstrings

Do not add module docstrings that only restate that a file contains tests. Test function docstrings are optional and must be one-line clarifications when the test name alone cannot explain the behavior.

### R16. Real DB tests are opt-in

In-memory integration tests run by default. Testcontainers and real database tests are reserved for migrations and DB-specific behavior and must require an explicit flag such as `--real-db`. Agent workflows must not start Docker or require a database unless the user explicitly requests real DB verification.

Backend-agnostic integration tests are preferred when the same repository/service behavior should hold for both in-memory and real DB backends. The exact fixture/session/config wiring is project-specific. In real DB mode, dummy session stores and in-memory session patches must be disabled.

---

## Cheap Writer Safety

Use this compact checklist whenever a low-cost writer model implements tests.

1. `AsyncMock(spec=Interface)` for async dependencies; no bare dependency `AsyncMock()`.
2. `MagicMock(spec=Interface)` only for sync dependencies; never for domain/Pydantic/protobuf data.
3. Polyfactory-backed factories for reusable entities, commands, and mapper inputs.
4. Real system under test with mocked dependencies; never mock the SUT or its method under test.
5. Module-level test functions by default; classes require explicit plan approval.
6. Test names describe behavior; one-line test docstrings are allowed only for clarification.
7. One behavior per test; mapper/validator tests may assert one output object's fields.
8. `assert result is not None` must be paired with behavior assertions.
9. Config changes use `monkeypatch` or `try/finally` restoration.
10. Skips always include `reason=`.
11. Reusable factories and fixtures are not defined directly in `test_*.py` files.
12. If Polyfactory is absent, add it to dev/test dependencies before adding reusable model factories.
13. Do not chase coverage with standalone runtime-type assertions for trivial wrappers or ID generators.
14. Do not reference temporary agent artifacts in committed tests or skip reasons.
15. Keep imports at module level; do not interleave imports with test logic.
16. Use Faker/Polyfactory and parametrization for arbitrary and boundary data.
17. Avoid boilerplate module docstrings such as `"""Tests for ..."""`.
18. Keep testcontainers behind `--real-db`; default test commands use in-memory backends.
19. Prefer backend-agnostic integration tests when behavior should match across in-memory and real DB backends.

---

## Test Directory Layout

```
<project-root>/
├── pyproject.toml                # [tool.pytest.ini_options]
├── <package>/
└── tests/
    ├── __init__.py
    ├── conftest.py               # Global: faker fixture, env patches
    ├── integration/
    │   ├── __init__.py
    │   ├── conftest.py           # Integration: in-memory repos, factory overrides
    │   ├── repositories/         # In-memory implementations
    │   └── test_*_flow.py
    ├── architecture/
    │   └── test_layering.py      # pytestarch layer-dependency rules
    └── <package>/
        ├── __init__.py
        ├── conftest.py           # Domain: mock fixtures for unit tests
        ├── business_logic/
        │   ├── services/test_*.py
        │   ├── orchestrators/test_*.py
        │   ├── validators/test_*.py
        │   └── commands/test_*.py
        ├── controller/
        │   └── grpc/test_*_mapper.py
        └── builders/
            ├── factories.py       # Optional: shared Polyfactory classes
            └── test_*.py
```

### Three conftest zones — different responsibilities

| Zone | File | Contents | Who loads it |
|------|------|----------|--------------|
| Global | `tests/conftest.py` | `faker` fixture, `os.environ` patches | Every test |
| Integration | `tests/integration/conftest.py` | In-memory repos, `autouse` factory overrides | `tests/integration/*` only |
| Domain | `tests/<pkg>/<mod>/conftest.py` | Mock repos, mock clients for unit tests | Unit tests in that subtree |

Reusable factories may live directly in the nearest domain `conftest.py` or in a sibling `factories.py` imported by that `conftest.py`. Keep `test_*.py` files focused on scenarios and assertions.

### Naming conventions

- Files: `test_<module>.py`
- Functions: `test_<action>_<expected_outcome>(...)`
- Factory classes: `<Entity>Factory` — Polyfactory-backed reusable builders
- Fixture factories: `create_test_<entity>(...)` — returned by fixtures when persistence or async setup is required

---

## Minimum Viable Setup

For a new project, these three things must exist:

1. **`tests/conftest.py`:**

```python
import pytest
from faker import Faker

@pytest.fixture(scope="session")
def faker() -> Faker:
    return Faker()
```

2. **`tests/integration/`** directory (may be empty)

3. **`pyproject.toml`** with:

```toml
[dependency-groups]
dev = [
    "pytest>=8,<10",
    "pytest-asyncio>=0.24,<1",
    "pytest-cov>=6,<10",
    "faker>=25,<40",
    "polyfactory>=2,<3",
    "ruff>=0.5,<1",
    "flake8-pytest-style>=2,<3",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"

[tool.ruff.lint]
select = ["PT"]

[tool.ruff.lint.flake8-pytest-style]
pytest-fixture-no-parentheses = true
pytest-mark-no-parentheses = true
pytest-parametrize-names-type = "csv"

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["S101", "SLF001"]
```

---

## Common Pattern Index

| Need | Look in |
|------|---------|
| Mock an async repository | [unit-tests.md](references/unit-tests.md) |
| Create real service with mock deps | [unit-tests.md](references/unit-tests.md) |
| Generate test data | [unit-tests.md](references/unit-tests.md) |
| Place reusable factories and fixtures | [fixtures.md](references/fixtures.md) |
| Parametrize a test | [unit-tests.md](references/unit-tests.md) |
| Write async tests | [unit-tests.md](references/unit-tests.md) |
| Build an in-memory repository | [integration-tests.md](references/integration-tests.md) |
| Override factory functions | [integration-tests.md](references/integration-tests.md) |
| Set up a real DB for testing | [integration-tests.md](references/integration-tests.md) |
| Mock gRPC context | [fixtures.md](references/fixtures.md) |
| Test gRPC/protobuf mappers | [grpc-protobuf-tests.md](references/grpc-protobuf-tests.md) |
| Override config in a test | [fixtures.md](references/fixtures.md) |
| Enforce layering rules | [architecture-tests.md](references/architecture-tests.md) |
| Set up project test infra | [pytest-config.md](references/pytest-config.md) |
| Avoid common mistakes | [antipatterns.md](references/antipatterns.md) |

---

## Verification Checklist

After writing or reviewing tests, group checks by test type:

### All tests

- [ ] `tests/conftest.py` exists with session-scoped `faker`
- [ ] `tests/integration/` directory exists
- [ ] Test file mirrors source path
- [ ] No `@pytest.mark.skip` without `reason="..."`
- [ ] Skip reasons do not mention temporary agent artifacts or non-committed files
- [ ] No session-scoped mutable fixtures (except `faker`)
- [ ] No reusable `_make_*`, `make_*`, `create_test_*`, or `@pytest.fixture` definitions in `test_*.py`
- [ ] Imports are at module level unless an exceptional inline import is justified
- [ ] No boilerplate module docstrings that only restate the file contains tests
- [ ] `asyncio_mode = "auto"` in pyproject.toml
- [ ] flake8-pytest-style rules active (PT checks pass)
- [ ] Default test command does not start Docker or require real DB services

### Unit tests

- [ ] All async mocks use `AsyncMock(spec=Interface)`
- [ ] Service under test is real, not mocked
- [ ] Reusable Pydantic/domain model test data uses Polyfactory
- [ ] Config override fixtures use try/finally
- [ ] No `MagicMock` is used as a domain/Pydantic/protobuf data object
- [ ] One-line test function docstrings clarify behavior instead of duplicating the test name
- [ ] No new `class Test...` unless the plan explicitly allowed it

### Low-cost writer audit

- [ ] Search changed tests for bare `AsyncMock()` and justify or fix every occurrence
- [ ] Search changed tests for `MagicMock()` and verify each use is a dependency mock, not data
- [ ] Search changed tests for `class Test` and confirm explicit plan approval
- [ ] Search changed tests for direct `config.` assignment and confirm restoration
- [ ] Search changed tests for `assert result is not None` and confirm behavior assertions
- [ ] Search changed `test_*.py` files for reusable `_make_*`, `make_*`, `create_test_*`, and `@pytest.fixture`
- [ ] Confirm reusable Pydantic/domain factories use Polyfactory or document why the setup is one-off local data
- [ ] Confirm new tests exercise behavior or public contracts, not only trivial runtime type wrappers
- [ ] Search changed tests for inline imports and move them to module level unless explicitly justified
- [ ] Search skip reasons for `.tmp/agent-testing`, `plan-`, `capsule`, `writer-report`, and `review-report`
- [ ] Search changed tests for hard-coded `test-*`, fixed IPs, versions, and namespaces; replace arbitrary values with Faker/Polyfactory
- [ ] Confirm repeated input/output variants use `pytest.mark.parametrize`

### Integration tests

- [ ] In-memory repos or testcontainers used (not mocks at repo level)
- [ ] Testcontainers are used only for `real_db` or `migration` tests gated by an explicit flag
- [ ] Backend-agnostic integration tests use the same test body across in-memory and real DB modes when applicable
- [ ] Dummy session stores and in-memory patches are disabled in real DB mode
- [ ] `deepcopy` used on read/write in in-memory repos
- [ ] LRU caches cleared in `autouse` fixtures

---

## Decision Log

| Decision | Why |
|----------|-----|
| `asyncio_mode = "auto"` | Less boilerplate than `@pytest.mark.asyncio` |
| Module-level functions over classes | Fixtures replace setUp/tearDown; flatter |
| `AsyncMock(spec=)` mandatory | Catches interface mismatches at setup time |
| In-memory repos by default; testcontainers by flag | Fast agent workflow plus opt-in DB semantics coverage |
| Polyfactory for reusable model factories | Consistent reusable test data construction |
| `model_construct()` inside factories or one-off setup | Don't validate unrelated fields when reusable factory overhead is not needed |
| Avoid standalone trivial wrapper tests | Coverage should protect behavior and public contracts |
| Self-contained skip reasons | Committed tests must not depend on temporary agent artifacts |
| Module-level imports | Tests stay readable and dependency failures appear at collection time |
| Faker/Polyfactory for arbitrary values | Generated data catches invalid assumptions and keeps tests realistic |
| Parametrize boundary cases | Variants are explicit and easier to review |
| In-memory by default, real DB by flag | Agent workflows stay fast while CI can verify DB semantics |
| `tests/integration/` required even if empty | Standardises structure |
| `deepcopy` in in-memory repos | Prevents mutation leaks |
| Alembic over `create_all` | Mirrors production deployment path |
