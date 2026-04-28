---
name: python-test-guide
description: "Guide for writing, reviewing, and generating consistent pytest unit tests across cloud platform Python projects. Covers fixtures, mocking (AsyncMock with spec), async testing, parametrization, conftest hierarchy, integration test patterns, test data generation (faker + polyfactory + hypothesis), pytestarch, and canonical pyproject.toml config."
---

# Python Unit Test Guide

Standard for writing pytest tests across all cloud platform projects.

---

## Quick Start

Minimal test module skeleton:

```python
# tests/<package>/<module>/test_<name>.py
import pytest
from unittest import mock

@pytest.mark.asyncio
async def test_create_entity_returns_entity_with_id(
    entity_service: EntityService,
    mock_entity_repository: mock.AsyncMock,
):
    """Create returns persisted entity with generated ID."""
    result = await entity_service.create(name="test")

    assert result.id is not None
    assert result.name == "test"
    mock_entity_repository.create.assert_awaited_once()
```

---

## Triggers

| Trigger | Action |
|---------|--------|
| `напиши тесты для {модуля}` | Generate test file following standards |
| `write unit tests for {module}` | Generate test file following standards |
| `review tests in {path}` | Audit existing tests against this guide |
| `добавь юнит-тесты` | Analyze module, generate test coverage |
| `check test coverage patterns` | Validate conftest hierarchy, fixture usage |
| `проверь тесты на соответствие стандарту` | Run verification checklist |

---

## Core Principles

1. **Functional tests over class-based** — module-level `async def` functions preferred over test classes (except validators/mappers where grouping makes sense)
2. **Real services with mocked dependencies** — instantiate the real service, inject `AsyncMock(spec=Interface)` for repositories/clients
3. **Three-level conftest hierarchy** — session (faker) → domain (mocks) → module (autouse patches)
4. **tests/integration/** is reserved — integration tests use in-memory repositories or testcontainers, never mocks at repository level
5. **Test what matters** — one logical assertion group per test, descriptive function names over docstrings

---

## Test Directory Structure

Canonical layout for any project:

```
<project-root>/
├── pyproject.toml              # pytest config in [tool.pytest.ini_options]
├── <package>/
└── tests/
    ├── __init__.py
    ├── conftest.py             # Level 1: session fixtures (faker, env patching)
    ├── integration/
    │   ├── __init__.py
    │   ├── conftest.py         # Level 2: in-memory repos, autouse factory overrides
    │   ├── repositories/       # In-memory implementations for testing
    │   └── test_*_flow.py      # End-to-end flows
    └── <package>/
        ├── __init__.py
        ├── conftest.py         # Level 3: domain-specific mock fixtures
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

**Naming conventions:**
- Test files: `test_<module_name>.py`
- Test functions: `test_<action>_<expected_outcome>(...)`
- Test classes (optional): `Test<Component>` for grouping parametrized cases
- Helper functions: `create_test_<entity>(...)` with default values

---

## conftest.py Hierarchy

### Level 1: `tests/conftest.py` — Session fixtures

```python
import pytest
from faker import Faker


@pytest.fixture(scope="session")
def faker() -> Faker:
    """Session-scoped Faker instance for deterministic test data."""
    return Faker()
```

**Rule:** Every project MUST have a `tests/conftest.py` with at minimum the `faker` fixture. This is the canonical pattern used across all 25+ production projects.

For projects needing environment variable patching before imports:

```python
# tests/conftest.py
import os
from unittest.mock import patch

_env_patcher = patch.dict(
    os.environ,
    {"MANAGE_KUBER_ALLOWED_SUBNET_RANGES": '["10.0.0.0/8"]'},
    clear=False,
)
_env_patcher.start()


def pytest_sessionfinish(session, exitstatus):
    _env_patcher.stop()
```

### Level 2: `tests/integration/conftest.py` — Integration

```python
import pytest
from unittest.mock import AsyncMock, patch


class InMemoryEntityRepository:
    """Full in-memory implementation of EntityRepository for integration tests."""
    def __init__(self):
        self._store: dict = {}

    async def create(self, entity) -> object:
        self._store[entity.id] = entity
        return entity

    def clear(self):
        self._store.clear()


@pytest.fixture
def in_memory_entity_repository():
    return InMemoryEntityRepository()


@pytest.fixture(autouse=True)
def override_factories(in_memory_entity_repository):
    """Transparently swap real factories for in-memory implementations."""
    with patch("project.factories.service.get_entity_repository",
               return_value=in_memory_entity_repository):
        # Clear LRU caches before and after
        orchestrator.get_entity_orchestrator.cache_clear()
        yield
        orchestrator.get_entity_orchestrator.cache_clear()
```

### Level 3: `tests/<package>/<domain>/conftest.py` — Module mocks

```python
import pytest
from unittest.mock import AsyncMock


@pytest.fixture
def mock_entity_repository() -> AsyncMock:
    """Mocked repository with spec for type checking."""
    mock = AsyncMock(spec=EntityRepository)
    mock.create.return_value = Entity.model_construct(...)
    mock.get_by_id.return_value = Entity.model_construct(...)
    return mock


@pytest.fixture
def entity_service(mock_entity_repository: AsyncMock) -> EntityService:
    """Real service with mocked repository dependency."""
    return EntityService(repository=mock_entity_repository)


@pytest.fixture(autouse=True)
def patch_session_context_manager(monkeypatch: pytest.MonkeyPatch):
    """Auto-patch DB session for all tests in this domain."""
    monkeypatch.setattr("module.session_context_manager", DummySessionContextManager())
```

---

## Fixture Patterns Catalog

### 1. Faker Fixture (REQUIRED — every project)

```python
@pytest.fixture(scope="session")
def faker() -> Faker:
    return Faker()
```

### 2. Repository Mock with spec (REQUIRED — unit tests)

```python
@pytest.fixture
def mock_entity_repository() -> AsyncMock:
    mock = AsyncMock(spec=EntityRepository)
    mock.create.return_value = Entity.model_construct(id=EntityID(uuid.uuid4()), name="test")
    return mock
```

**Rule:** Always use `spec=` on AsyncMock for repository and client interfaces. Catches typos and contract violations at test time.

### 3. Real Service with Injected Mock (REQUIRED — unit tests)

```python
@pytest.fixture
def entity_service(mock_entity_repository: AsyncMock) -> EntityService:
    return EntityService(repository=mock_entity_repository)
```

### 4. Creator Factory Fixture (RECOMMENDED — complex objects)

```python
@pytest_asyncio.fixture
async def create_entity(entity_model):
    service = get_entity_service()

    async def _create(fields: dict | None = None):
        async with session_context_manager:
            model = EntityModelFactory.build(**(fields or {}))
            return await service.create(model)

    return _create
```

Pattern: outer fixture sets up dependencies, returns inner `_create(fields=...)` closure.

### 5. Config Override Fixture (RECOMMENDED — edge case tests)

```python
@pytest.fixture
def set_feature_flag_enabled():
    from project.config import config
    original = config.feature.enabled
    try:
        config.feature.enabled = True
        yield
    finally:
        config.feature.enabled = original
```

Pattern: save → yield modified → restore in `finally`.

### 6. autouse Session Mock (REQUIRED — integration tests)

```python
@pytest.fixture(autouse=True)
def mock_session_context_manager():
    mock_cm = AsyncMock()
    mock_cm.__aenter__.return_value = None
    mock_cm.__aexit__.return_value = None
    with patch("project.infrastructure.database.connection.session_context_manager", mock_cm):
        yield
```

### 7. gRPC Context Mock (RECOMMENDED — controller tests)

```python
@pytest.fixture
def mock_grpc_context() -> MagicMock:
    context = MagicMock()
    context.invocation_metadata.return_value = [
        ("user_id", str(uuid.uuid4())),
        ("project_id", str(uuid.uuid4())),
        ("x_request_id", str(uuid.uuid4())),
    ]
    return context
```

### 8. Polyfactory ModelFactory (OPTIONAL — auto-generate test data)

```python
from polyfactory.factories.pydantic_factory import ModelFactory

class SparkModelFactory(ModelFactory[SparkModel]):
    __model__ = SparkModel
    __use_examples__ = True

    @classmethod
    def next_semver(cls, last_version: str | None) -> str:
        if not last_version:
            return "1.0.0"
        major, minor, patch = map(int, last_version.split("."))
        patch += 1
        return f"{major}.{minor}.{patch}"
```

### 9. Hypothesis Strategy (OPTIONAL — property-based testing)

```python
from hypothesis import given, settings, strategies as st

settings.register_profile("production", max_examples=1024)

@given(
    entity_id=st.uuids(version=4),
    name=st.text(min_size=4, max_size=63, alphabet=list(string.ascii_lowercase)),
    status=st.sampled_from(StatusEnum),
)
def test_map_entity_roundtrips(entity_id, name, status):
    proto = EntityProto(id=str(entity_id), name=name, status=status)
    result = map_proto_to_entity(proto)
    assert result.id == EntityID(entity_id)
```

---

## Mocking Strategy

### Decision Matrix

| What to Mock | How | When |
|-------------|-----|------|
| Repository (async) | `AsyncMock(spec=RepositoryClass)` | Unit tests always |
| External API client | `AsyncMock(spec=ClientClass)` | Unit tests always |
| gRPC channel/client | `AsyncMock(spec=aio.Channel)` | Unit tests |
| DB session | `autouse=True AsyncMock` context manager | Integration tests |
| Config values | Save/restore via fixture | Edge case tests |
| Private methods | `obj._Class__method = AsyncMock()` | Last resort |
| Factory functions | `@patch("path.to.factory", return_value=mock)` | Integration tests |

### What NOT to Mock

- The service/class under test — always real
- Domain models/entities — use `model_construct()` for bypass, not mocks
- Pydantic validators — test through model construction
- Orchestrator under test — mock only its dependencies

### Mock Verification Patterns

```python
# Preferred: assert_awaited_once / assert_awaited_once_with
mock_repo.create.assert_awaited_once_with(expected_entity)

# For call_args inspection:
call_kwargs = mock_repo.update.call_args.kwargs
assert call_kwargs["entity_id"] == expected_id

# For bulk operations verification:
assert mock_service.start_workflow.called
assert mock_service.start_workflow.call_args.kwargs["operation_type"] == WorkflowKey.create.key
```

---

## Async Testing

### Configuration (pyproject.toml)

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
```

**Rule:** Use `asyncio_mode = "auto"` (preferred) — no need for `@pytest.mark.asyncio` on every test.

If using explicit markers (legacy projects):

```python
import pytest

@pytest.mark.asyncio
async def test_something():
    ...
```

### Fixtures with Async Operations

```python
@pytest_asyncio.fixture
async def seeded_entity(entity_service):
    """Create entity in DB for test."""
    return await entity_service.create(name="test")
```

### Async Mock Methods

```python
# Always use AsyncMock for async dependencies
mock_repo = AsyncMock(spec=EntityRepository)
mock_repo.get_by_id.return_value = entity

# Verification uses assert_awaited_* variants
mock_repo.get_by_id.assert_awaited_once_with(entity_id)
```

---

## Parametrization

### When to Use

| Scenario | Use parametrize |
|----------|----------------|
| Same logic, different inputs | Yes |
| Status-dependent behavior | Yes |
| Validation boundary checks | Yes |
| Matrix of two dimensions | Nested parametrize |
| Distinctly different behaviors | Separate test functions |
| Complex multi-step setups | Separate test functions |

### Standard Pattern

```python
import pytest

@pytest.mark.parametrize(
    ("input_value", "expected"),
    [
        ("0", 0),
        ("123", 123),
        ("1K", 1 << 10),
        ("3m", 3 * (1 << 20)),
    ],
)
async def test_parse_string_to_bytes(input_value, expected):
    assert parse(input_value) == expected
```

### With Exception Expectations

```python
from contextlib import nullcontext as does_not_raise

@pytest.mark.parametrize(
    ("status", "raise_expectation", "match_text"),
    [
        (Status.RUNNING, does_not_raise(), None),
        (Status.CREATING, pytest.raises(ActionUnavailableError), "not allowed"),
        (Status.ERROR, pytest.raises(ActionUnavailableError), "not allowed"),
    ],
)
async def test_validate_status(status, raise_expectation, match_text):
    with raise_expectation as exc:
        await validate(status)
    if match_text:
        assert match_text in str(exc.value)
```

### Nested Parametrization (Matrix Testing)

```python
@pytest.mark.parametrize("job_type", [
    {"type": JobType.PYTHON},
    {"type": JobType.JAVA, "main_class": "Main"},
])
@pytest.mark.parametrize("image", [
    {"image_type": ImageType.CUSTOM, "uri": "custom:latest"},
    {"image_type": ImageType.BASE},
])
async def test_get_job(job_type, image):
    fields = {**job_type, **image}
    ...
```

---

## Integration Testing

### Location: `tests/integration/`

**Rule:** Every production project MUST have `tests/integration/` reserved for integration tests. It may be empty initially but the directory must exist.

### In-Memory Repository Pattern (PREFERRED)

```python
class InMemoryEntityRepository(EntityRepository):
    """Full interface implementation for integration testing."""

    def __init__(self):
        self._store: dict = {}
        self._deleted: set = set()

    async def create(self, entity: Entity) -> Entity:
        self._store[entity.id] = deepcopy(entity)
        return deepcopy(entity)

    async def get_by_id(self, entity_id: EntityID) -> Entity | None:
        return deepcopy(self._store.get(entity_id))

    def clear(self):
        self._store.clear()
        self._deleted.clear()
```

### Testcontainers Pattern (FOR DB-CENTRIC TESTS)

```python
from testcontainers.postgres import PostgresContainer

@pytest.fixture(scope="module")
def session():
    with PostgresContainer("postgres:16") as psql:
        engine = create_engine(psql.get_connection_url())
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        with Session() as session:
            yield session
```

**Decision:** Use in-memory repositories for most integration tests. Use testcontainers only when testing actual SQL behavior (migrations, complex queries, database-library code).

### Integration Test Characteristics

- Real controller → orchestrator → service → repository flow
- Only external boundaries mocked (kuber client, IAM, billing, etc.)
- Use actual protobuf request/response objects in gRPC tests
- Assert on final state, not intermediate mock calls

---

## Test Data Generation

### Faker (REQUIRED — all tests)

```python
# In conftest.py (session-scoped)
@pytest.fixture(scope="session")
def faker() -> Faker:
    return Faker()

# In test:
def test_something(faker):
    name = faker.word()
    email = faker.email()
```

### model_construct() for Pydantic Models (RECOMMENDED)

```python
entity = Entity.model_construct(
    id=EntityID(uuid.uuid4()),
    name=faker.domain_word(),
    status=EntityStatus.running,
    created_at=datetime.now(timezone.utc),
)
```

**Rule:** Use `model_construct()` to bypass validation when creating test data. This makes tests faster and isolates them from unrelated validation rules.

### Polyfactory ModelFactory (OPTIONAL)

```python
from polyfactory.factories.pydantic_factory import ModelFactory

class EntityModelFactory(ModelFactory[Entity]):
    __model__ = Entity
    __use_examples__ = True

# Usage:
entity = EntityModelFactory.build(name="custom_name", status="active")
```

### Hypothesis for Property-Based Tests (OPTIONAL)

```python
from hypothesis import given, settings, strategies as st

settings.register_profile("production", max_examples=1024)

@given(
    input_str=st.text(min_size=0, max_size=1000),
)
def test_parser_never_crashes(input_str):
    try:
        parse(input_str)
    except ValueError:  # Expected for invalid input
        pass
    # Must never raise TypeError, AttributeError, etc.
```

---

## Assertion Style

### DO

```python
# Plain assertions with descriptive variable names
assert result.status == EntityStatus.running
assert len(entities) == 3
assert "10.100.0.0/16" in str(exc_info.value)

# pytest.raises with match for exceptions
with pytest.raises(ValueError, match="Invalid memory string"):
    parse("not_a_number")

# Mock verification
mock_repo.create.assert_awaited_once_with(expected_entity)
assert mock_repo.delete.called

# is/is not for None checks
assert result is not None
assert entity.error_info is None
```

### DON'T

```python
# No bare assert without message context
assert result  # what does this mean?

# No assertEqual style (use plain assert)
self.assertEqual(a, b)  # ❌

# No manual try/except for expected exceptions
try:                        # ❌
    parse("bad")
except ValueError:
    pass
```

---

## Project Configuration

### Canonical pyproject.toml [tool.pytest.ini_options]

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
filterwarnings = [
    "ignore:datetime.datetime.utcnow\\(\\) is deprecated:DeprecationWarning",
]
```

### Canonical Dev Dependencies

```toml
[dependency-groups]
dev = [
    # Core
    "pytest>=8.4,<10",
    "pytest-asyncio>=0.24",
    "pytest-cov>=6.0",
    "pytest-mock>=3.15",         # Only if using mocker fixture

    # Quality
    "pytest-deadfixtures>=2.2",   # Detect unused fixtures
    "pytest-randomly>=3.15",      # Random test order
    "pytest-xdist>=3.6",          # Parallel execution

    # Test data
    "faker>=30",
    "polyfactory>=2.16",          # Optional: model factories

    # Integration
    "testcontainers>=4.0",        # Optional: real DB testing
    "pytest-alembic>=0.11",       # Optional: migration tests
    "pytest-async-sqlalchemy>=0.2", # Optional: async SQL

    # Fuzzing (optional)
    "hypothesis>=6.150",

    # Linting
    "ruff>=0.5",
    "flake8-pytest-style>=2.0",
]
```

### ruff Configuration for Tests

```toml
[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = [
    "S101",   # assert is expected in tests
    "SLF001", # Private member access allowed in tests
]
```

---

## Linting Rules (flake8-pytest-style)

These rules are enforced project-wide and MUST be followed:

```toml
[tool.ruff.lint]
select = [
    "PT",  # flake8-pytest-style
]

[tool.ruff.lint.flake8-pytest-style]
pytest-fixture-no-parentheses = true
pytest-mark-no-parentheses = true
pytest-parametrize-names-type = "csv"
```

### What These Rules Enforce

| Rule | Example |
|------|---------|
| `@pytest.fixture()` → `@pytest.fixture` | No empty parens on decorators |
| `@pytest.mark.skip()` → `@pytest.mark.skip` | No empty parens on marks |
| Parametrize names as CSV | `"a,b"` not `("a", "b")` |

---

## Architecture Testing (pytestarch)

**Adoption plan:** `pytestarch>=3.1` is installed in trino-instance but not yet used. This section defines the target rules for universal adoption.

### Target Rules

```python
from pytestarch import Rule, ArchTests

class TestArchitecture:
    """Architecture rules for project layering."""

    def test_services_do_not_import_controllers(self, arch: ArchTests):
        arch.assert_rule(
            Rule()
            .modules_that("*.business_logic.services.*")
            .should_not()
            .import_modules("*.controller.*")
        )

    def test_repositories_are_only_in_infrastructure(self, arch: ArchTests):
        arch.assert_rule(
            Rule()
            .modules_that("*.repositories.*")
            .should()
            .be_in("*.infrastructure.database.*")
        )
```

---

## Anti-Patterns

| Anti-Pattern | Why Bad | Instead |
|-------------|---------|---------|
| Mocking the service under test | Tests nothing | Real service + mocked dependencies |
| `MagicMock()` without `spec=` | No type safety, silent typos | `AsyncMock(spec=Interface)` |
| `@pytest.fixture(scope="session")` for mutable state | State leaks between tests | Function scope + factory fixtures |
| Inline `Faker()` in every test | Non-deterministic seeds | One session-scoped `faker` fixture |
| Tests without `tests/integration/` | No integration coverage | At minimum reserve the directory |
| `mock.patch` inside test body instead of fixture | Mixing setup and assertion | autouse fixture or decorator |
| Nested `with patch(...)` in tests | Hard to read, leaky | autouse fixture with yield |
| `pytest.mark.skip` without reason string | Unclear why skipped | Always include `reason="..."` |
| DB-dependent unit tests | Slow, flaky | Mock repositories, use in-memory for integration |

---

## Verification Checklist

After writing or reviewing tests, verify:

- [ ] `tests/conftest.py` exists with `faker` fixture (scope="session")
- [ ] `tests/integration/` directory exists
- [ ] Test file mirrors source path: `tests/<package>/<module>/test_<name>.py`
- [ ] All async mocks use `AsyncMock(spec=InterfaceClass)`
- [ ] Services are instantiated with mocked dependencies (not mocked themselves)
- [ ] `model_construct()` used for test data (not real model creation with validation)
- [ ] `asyncio_mode = "auto"` in `[tool.pytest.ini_options]`
- [ ] `flake8-pytest-style` rules active (PT checks pass)
- [ ] No `@pytest.mark.skip` without `reason="..."`
- [ ] Integration tests use in-memory repos or testcontainers (not mocks at repo level)
- [ ] LRU caches cleared in integration `autouse` fixtures
- [ ] Config override fixtures use try/finally to restore
- [ ] `deepcopy` used when returning mutable objects from in-memory repos

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| `asyncio_mode = "auto"` over explicit markers | Less boilerplate, fewer forgotten decorators |
| Module-level functions over test classes | Flat is better than nested; fixtures replace setUp/tearDown |
| `AsyncMock(spec=)` mandatory | Catches interface mismatches early |
| In-memory repos for integration over testcontainers | Faster, simpler, works without Docker |
| `model_construct()` over `Model()` | Tests don't validate unrelated fields |
| Session-scoped faker over per-test Faker() | Deterministic when seeded, shared setup |
| `tests/integration/` required even if empty | Signals intent, standardizes structure |
| `deepcopy` in in-memory repos | Prevents test data mutation leaks |

---

## References

- [Detailed Fixture Patterns](references/fixtures.md) — Expanded fixture catalog with real project examples
- [Anti-Patterns Deep Dive](references/antipatterns.md) — Concrete anti-patterns found in existing projects
- [Canonical pyproject.toml](references/pytest-config.md) — Full pyproject.toml template for new projects
- [Resource: pytest docs](https://docs.pytest.org/)
- [Resource: pytest-asyncio](https://pytest-asyncio.readthedocs.io/)
- [Resource: flake8-pytest-style](https://github.com/m-burst/flake8-pytest-style)

---

## Extension Points

1. **pytestarch rules** — Add architecture tests as standard across projects
2. **Coverage thresholds** — Define minimum coverage per domain (currently project-specific)
3. **Performance test patterns** — Add patterns for benchmarking-critical paths
4. **Snapshot testing** — Consider syrupy/snapshottest for complex output verification
5. **Mutation testing** — Evaluate mutmut/cosmic-ray for test quality assessment
6. **CI integration** — Standardize pytest invocation across CI pipelines
