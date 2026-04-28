---
name: python-test-guide
description: "Use when asked to write, review, or audit pytest tests for a Python service. Covers unit, integration, and architecture tests — when to use each, how to structure them, what patterns to follow."
user-invocable: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
metadata:
  version: 1.1.1
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
            └── test_*.py
```

### Three conftest zones — different responsibilities

| Zone | File | Contents | Who loads it |
|------|------|----------|--------------|
| Global | `tests/conftest.py` | `faker` fixture, `os.environ` patches | Every test |
| Integration | `tests/integration/conftest.py` | In-memory repos, `autouse` factory overrides | `tests/integration/*` only |
| Domain | `tests/<pkg>/<mod>/conftest.py` | Mock repos, mock clients for unit tests | Unit tests in that subtree |

### Naming conventions

- Files: `test_<module>.py`
- Functions: `test_<action>_<expected_outcome>(...)`
- Helpers: `create_test_<entity>(...)` — takes default kwargs

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
| Parametrize a test | [unit-tests.md](references/unit-tests.md) |
| Write async tests | [unit-tests.md](references/unit-tests.md) |
| Build an in-memory repository | [integration-tests.md](references/integration-tests.md) |
| Override factory functions | [integration-tests.md](references/integration-tests.md) |
| Set up a real DB for testing | [integration-tests.md](references/integration-tests.md) |
| Mock gRPC context | [fixtures.md](references/fixtures.md) |
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
- [ ] No session-scoped mutable fixtures (except `faker`)
- [ ] `asyncio_mode = "auto"` in pyproject.toml
- [ ] flake8-pytest-style rules active (PT checks pass)

### Unit tests

- [ ] All async mocks use `AsyncMock(spec=Interface)`
- [ ] Service under test is real, not mocked
- [ ] `model_construct()` used for Pydantic models in test data
- [ ] Config override fixtures use try/finally

### Integration tests

- [ ] In-memory repos or testcontainers used (not mocks at repo level)
- [ ] `deepcopy` used on read/write in in-memory repos
- [ ] LRU caches cleared in `autouse` fixtures

---

## Decision Log

| Decision | Why |
|----------|-----|
| `asyncio_mode = "auto"` | Less boilerplate than `@pytest.mark.asyncio` |
| Module-level functions over classes | Fixtures replace setUp/tearDown; flatter |
| `AsyncMock(spec=)` mandatory | Catches interface mismatches at setup time |
| In-memory repos over testcontainers | Faster, no Docker dependency |
| `model_construct()` for test models | Don't validate unrelated fields |
| `tests/integration/` required even if empty | Standardises structure |
| `deepcopy` in in-memory repos | Prevents mutation leaks |
| Alembic over `create_all` | Mirrors production deployment path |
