# Integration Test Patterns

Tests that exercise more than one real layer. Two strategies: in-memory repositories by default and opt-in testcontainers for DB-centric or migration tests.

---

## When to Write an Integration Test

- Testing a full flow: controller → orchestrator → service → repository
- Testing that an orchestrator correctly coordinates multiple services
- Testing repository behaviour against real storage
- Testing gRPC request/response mapping end-to-end
- Testing that LRU-cached factory functions produce correct instances

**Rule:** Mock ONLY external boundaries. Everything inside the project boundary is real.

---

## Strategy 1: In-Memory Repositories (DEFAULT)

Fast, no Docker, works everywhere. This is the default for local development and agent workflows because tests may run many times per session.

### Implementation

```python
# tests/integration/repositories/entity.py
from copy import deepcopy

class InMemoryEntityRepository(EntityRepository):
    """Full interface implementation for integration testing."""

    def __init__(self):
        self._store: dict = {}
        self._deleted: set = set()

    async def create(self, entity: Entity) -> Entity:
        self._store[entity.id] = deepcopy(entity)
        return deepcopy(entity)

    async def get(self, entity_id: EntityID) -> Entity | None:
        entity = self._store.get(entity_id)
        return deepcopy(entity) if entity else None

    async def list(self, parent_id: UUID) -> list[Entity]:
        return [
            deepcopy(e)
            for e in self._store.values()
            if e.parent_id == parent_id
        ]

    async def delete(self, entity_id: EntityID) -> None:
        self._deleted.add(entity_id)

    def clear(self):
        self._store.clear()
        self._deleted.clear()
```

**Key rules:**
1. Implement ALL interface methods — not just the ones used in current tests
2. Use `deepcopy` on write (`create`) and read (`get`, `list`) to prevent mutation leaks
3. Provide a `clear()` method for test isolation
4. Mirror exact semantics: `get` returns `None` for missing, `list` returns `[]`

### Factory Override Fixture

LRU-cached factory functions (decorated with `@functools.lru_cache`) need `cache_clear()` between tests to force fresh instances:

```python
# tests/integration/conftest.py
from unittest.mock import patch

@pytest.fixture(autouse=True)
def override_factories(in_memory_entity_repository):
    """Swap real factory functions for in-memory implementations."""
    with patch(
        "project.factories.module.get_entity_repository",
        return_value=in_memory_entity_repository,
    ):
        # `cache_clear()` is a method provided by `functools.lru_cache`.
        # It resets the cache so the next call returns a fresh instance
        # with our in-memory repository.
        orchestrator.get_entity_orchestrator.cache_clear()
        yield
        orchestrator.get_entity_orchestrator.cache_clear()
```

**Why `autouse=True`:** Transparent factory override for every integration test.

### Integration Test

```python
async def test_create_entity_full_flow(
    mock_grpc_context: MagicMock,
    mock_external_client: AsyncMock,
):
    """Controller → orchestrator → service → repository flow."""
    controller = EntityController()
    request = CreateRequest(project_id="p-1", name="test-entity")

    # Only external boundaries are mocked
    mock_external_client.validate.return_value = {"allowed": True}

    response = await controller.Create(request, mock_grpc_context)

    assert response.entity.name == "test-entity"
    assert response.entity.status == ENTITY_STATUS_ACTIVE
    mock_external_client.create_resource.assert_awaited_once()
```

Note: With `asyncio_mode = "auto"` (see [pytest-config.md](pytest-config.md)), `async def` tests don't need `@pytest.mark.asyncio`.

---

## Strategy 2: Testcontainers (OPT-IN FOR DB-CENTRIC CODE)

Use only when testing SQL-specific behaviour: migrations, foreign keys, unique constraints, JSONB/ARRAY/enums, transaction rollback/isolation, locking, upserts, complex queries, or ORM mappings.

Do not use testcontainers for domain entities, mappers, validators, unit-level orchestrator tests, or integration flows that can be honestly covered through in-memory repositories.

### Real DB flag pattern

Real DB tests are opt-in. Default `uv run pytest` must not start Docker or require a database. Users and CI can enable real DB coverage explicitly:

```bash
# Fast default path for agents and local work
uv run pytest

# Real PostgreSQL path for CI or manual verification
uv run pytest --real-db -m real_db

# Migration-specific path
uv run pytest --real-db -m migration
```

Use a pytest option plus markers:

```python
# tests/conftest.py or tests/integration/conftest.py
import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--real-db",
        action="store_true",
        default=False,
        help="Run real PostgreSQL tests via testcontainers.",
    )


def pytest_configure(config):
    config.addinivalue_line("markers", "real_db: requires PostgreSQL testcontainer")
    config.addinivalue_line("markers", "migration: requires migrated PostgreSQL schema")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--real-db"):
        return
    skip_real_db = pytest.mark.skip(reason="Use --real-db to run PostgreSQL testcontainer tests")
    for item in items:
        if "real_db" in item.keywords or "migration" in item.keywords:
            item.add_marker(skip_real_db)
```

Do not set default `addopts` that excludes all integration tests. Only real DB and migration tests should be gated by `--real-db`; in-memory integration tests should keep running by default.

### Dual backend fixture pattern

Prefer backend-agnostic integration tests when the same behavior should hold for both in-memory and real database repositories. The exact implementation is project-specific and must be planned from the repository's existing session/config patterns.

The general idea is: tests depend on repository/service fixtures, while fixtures choose the backend. Without `--real-db`, fixtures use in-memory repositories. With `--real-db`, the same tests use real database repositories after migrations are applied.

Example shape, not a universal template:

```python
@pytest.fixture
def project_repository(request, in_memory_project_repository, real_project_repository):
    if request.config.getoption("--real-db"):
        return real_project_repository
    return in_memory_project_repository
```

Use this pattern only for tests that are intentionally backend-agnostic. Prefer separate `@pytest.mark.real_db` tests when the assertion depends on PostgreSQL-specific semantics.

### Real DB mode disables dummy session patches

In real DB mode, do not use dummy session stores, dummy session context managers, or in-memory factory overrides that bypass the real database session. Any such patch must be guarded so it applies only to the in-memory backend.

Example shape, not a universal template:

```python
@pytest.fixture(autouse=True)
def patch_session_for_in_memory_only(request, monkeypatch):
    if request.config.getoption("--real-db"):
        return
    monkeypatch.setattr(target_module, "session_context_manager", DummySessionContextManager())
```

The planner and writer must determine the actual project-specific configuration surface: environment variables, config object, session factory, repository factory, or dependency-injection container.

### Alembic Migration Approach

```python
from testcontainers.postgres import PostgresContainer
from alembic.config import Config
from alembic import command
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

@pytest.fixture(scope="module")
def migrated_db():
    """Spin up Postgres and run alembic migrations."""
    with PostgresContainer("postgres:16") as psql:
        connection_url = psql.get_connection_url()
        engine = create_engine(connection_url)

        alembic_cfg = Config("alembic.ini")
        alembic_cfg.set_main_option("sqlalchemy.url", connection_url)
        command.upgrade(alembic_cfg, "head")

        Session = sessionmaker(bind=engine)
        with Session() as session:
            yield session
```

**Why alembic over `create_all`:** Alembic applies the full migration history, catching issues with your migration chain. Mirrors production deployment.

### Seeding Data

```python
@pytest.fixture
def seeded_db(migrated_db):
    """Populate with known test records."""
    migrated_db.query(Entity).delete()

    entities = [
        Entity(id=uuid.uuid4(), name="alpha", status="active"),
        Entity(id=uuid.uuid4(), name="beta", status="inactive"),
    ]
    migrated_db.add_all(entities)
    migrated_db.commit()
    return entities
```

---

## Optional: Integration Test Markers

```toml
[tool.pytest.ini_options]
markers = [
    "integration: Full-flow tests using in-memory repos; runs by default",
    "real_db: PostgreSQL testcontainer tests; require --real-db",
    "migration: Alembic migration tests; require --real-db",
]
```

```python
@pytest.mark.integration
async def test_full_create_flow():
    ...
```

Run unit only: `pytest -m "not integration"`
Run integration only: `pytest -m integration`
Run real DB only: `pytest --real-db -m real_db`
Run migrations only: `pytest --real-db -m migration`

---

## Integration vs Unit: Quick Reference

| Aspect | Unit test | Integration test |
|--------|-----------|------------------|
| Location | `tests/<pkg>/.../` | `tests/integration/` |
| Repositories | `AsyncMock(spec=Repo)` | `InMemoryRepo()` (real) |
| Services | Real + mock deps | Real + real repos |
| External APIs | Mocked | Mocked |
| DB | None | In-memory by default; testcontainers only for `real_db`/`migration` |
| Factories | Not relevant | `autouse` patching + `cache_clear()` |
| Speed | <100ms | <1s (in-memory) / 1-10s (containers) |

---

## Common Mistakes

1. **Mocking repositories in integration tests** — defeats the purpose. Use in-memory implementations.
2. **Forgetting `cache_clear()`** — LRU-cached factories return stale instances.
3. **No `deepcopy` in in-memory repos** — tests mutate stored objects, leaking state.
4. **Trying to test external API integration** — that's end-to-end, not integration. Mock external boundaries.
5. **Using testcontainers for simple CRUD** — overkill. In-memory repos are faster and sufficient.
