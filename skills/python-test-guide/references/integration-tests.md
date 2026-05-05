# Integration Test Patterns

Tests that exercise more than one real layer. Two strategies: in-memory repositories by default and opt-in testcontainers for dual-backend parity or DB-centric verification.

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

## Strategy 2: Testcontainers (OPT-IN FOR PARITY OR DB-CENTRIC CODE)

Use a real DB backend only when either of these is true:

1. You are rerunning backend-agnostic integration tests for parity against the real repository/session wiring.
2. You are testing SQL-specific behaviour: migrations, foreign keys, unique constraints, JSONB/ARRAY/enums, transaction rollback/isolation, locking, upserts, complex queries, or ORM mappings.

Do not use testcontainers for domain entities, mappers, validators, unit-level orchestrator tests, or as a replacement for the fast in-memory default path.

### Real DB flag pattern

Real DB tests are opt-in. Default `uv run pytest` must not start Docker or require a database. Users and CI can enable parity and DB-specific coverage explicitly:

```bash
# Fast default path for agents and local work
uv run pytest

# Same backend-agnostic integration tests against the real DB
uv run pytest --real-db -m integration

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

Backend-agnostic parity tests should usually carry `@pytest.mark.integration` only. The backend switch belongs in fixtures, not in duplicated test bodies or a second marker.

### Backend parity is the default shape for backend-agnostic behavior

When the same repository or service behavior should hold for both in-memory and real DB backends, prefer this workflow:

1. Write one `@pytest.mark.integration` test body.
2. Make repository or service fixtures choose the backend.
3. Run that same integration selection twice when parity matters:

```bash
# Fast local and agent verification
uv run pytest -m integration

# CI or manual parity rerun against the real DB
uv run pytest --real-db -m integration
```

Reserve `@pytest.mark.real_db` for assertions that depend on PostgreSQL-specific semantics. Reserve `@pytest.mark.migration` for schema migration coverage.

### Coverage command shape for real DB verification

Prefer `pytest-cov` for the default repository workflow when it already works for broad package coverage:

```bash
# Broad package coverage
uv run pytest --real-db tests/integration -q --cov=package_name --cov-report=xml --cov-fail-under=0
```

For narrow scopes, prefer filesystem paths in `--cov`:

```bash
# Narrow directory coverage
uv run pytest --real-db tests/integration/path/to/test_file.py -q --cov=package_name/subpackage --cov-report=term
```

Avoid dotted narrow sources such as `--cov=package_name.subpackage.module` unless the repository explicitly documents them as safe. Coverage treats non-directory `--cov` values as importable names, which can trigger early import side effects before tests run.

Use `coverage run` only when the repository documents a compatible config for `PyTracer`. If the active coverage config uses unsupported concurrency options such as `greenlet`, `coverage run --timid` can fail unless a dedicated config or `--rcfile` override is provided.

### Dual backend fixture pattern

Prefer backend-agnostic integration tests when the same behavior should hold for both in-memory and real database repositories. The exact implementation is project-specific and must be planned from the repository's existing session/config patterns.

The general idea is: tests depend on repository/service fixtures, while fixtures choose the backend. Without `--real-db`, fixtures use in-memory repositories. With `--real-db`, the same tests use real database repositories after migrations are applied.

Example shape, not a universal template:

```python
@pytest.fixture
def project_repository(request):
    if request.config.getoption("--real-db"):
        return request.getfixturevalue("real_project_repository")
    return request.getfixturevalue("in_memory_project_repository")
```

Use this pattern only for tests that are intentionally backend-agnostic. Prefer separate `@pytest.mark.real_db` tests when the assertion depends on PostgreSQL-specific semantics.

Using `request.getfixturevalue(...)` avoids resolving the unused backend chain. This matters when the real DB backend would start Docker or require optional dependencies that should stay dormant during the default in-memory run.

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

@pytest.fixture(scope="session")
def postgres_container_url():
    """Start Postgres once and apply Alembic migrations."""
    with PostgresContainer("postgres:16") as psql:
        connection_url = psql.get_connection_url()
        alembic_cfg = Config("alembic.ini")
        alembic_cfg.set_main_option("sqlalchemy.url", connection_url)
        command.upgrade(alembic_cfg, "head")
        yield connection_url


@pytest.fixture
def migrated_db(postgres_container_url):
    engine = create_engine(postgres_container_url)
    Session = sessionmaker(bind=engine)
    with Session() as session:
        yield session
```

**Why alembic over `create_all`:** Alembic applies the full migration history, catching issues with your migration chain. Mirrors production deployment.

Prefer a session-scoped container when one run verifies several test modules against the same real DB backend. Recreating the container per module slows verification and can introduce avoidable startup flakiness.

If the repository's Alembic environment rewrites the DB URL from application config, prefer a shared-connection migration flow instead of mutating global config in tests. Example shape:

```python
def _run_upgrade(connection, cfg: AlembicConfig) -> None:
    cfg.attributes["connection"] = connection
    alembic.command.upgrade(cfg, "head")


async def _apply_migrations(async_url: str) -> None:
    engine = create_async_engine(async_url, pool_pre_ping=True)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(_run_upgrade, AlembicConfig("alembic.ini"))
    finally:
        await engine.dispose()
```

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

### Real DB cleanup and isolation

Keep the container long-lived for the test session, but keep database state isolated per test with a function-scoped cleanup fixture.

Cleanup must respect foreign-key order and repository-specific persistence surfaces. Example shape:

```python
@pytest.fixture
async def real_db_session(postgres_container_url):
    engine = create_async_engine(postgres_container_url, pool_pre_ping=True)
    factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        await session.execute(text("DELETE FROM public.child_table"))
        await session.execute(text("DELETE FROM public.parent_table"))
        await session.commit()
        yield session
    await engine.dispose()
```

Do not guess cleanup order. Read the repository tables, junction tables, and FK directions first.

### Contract parity checks

Backend parity work does not only validate fixture wiring. It also validates that the in-memory repository and the real repository implement the same contract.

Before claiming parity, compare:

1. filtering semantics such as whether soft-deleted rows are excluded;
2. pagination/count behavior such as whether totals exist only when pagination is requested;
3. update semantics for missing rows;
4. uniqueness and foreign-key constraints enforced only by the real DB.

If the real repository defines the production contract, fix the in-memory repository or the test expectation instead of keeping a knowingly divergent parity test.

### QueryBuilder field naming

When pagination, sorting, or filtering is delegated to a query builder that expects qualified field names, use the repository table prefix from the actual model mapping.

Example:

```python
FilterParams(
    pagination=OffsetPagination(
        page_size=10,
        direction=Direction.ASC,
        field="cluster_version.version",
        offset=0,
    )
)
```

Do not assume bare field names such as `"version"` are accepted in real DB mode.

### Realistic unique data

When real DB tables enforce uniqueness, test data must respect those constraints unless the test intentionally verifies the error.

For example, if `cluster_version.version` is unique, create explicit distinct versions in parity tests instead of relying on a reusable factory default that returns the same value repeatedly.

---

## Optional: Integration Test Markers

```toml
[tool.pytest.ini_options]
markers = [
    "integration: Backend-agnostic integration tests; run by default and can rerun with --real-db",
    "real_db: PostgreSQL testcontainer tests; require --real-db",
    "migration: Alembic migration tests; require --real-db",
]
```

```python
@pytest.mark.integration
async def test_full_create_flow():
    ...
```

Run unit only: `uv run pytest -m "not integration"`
Run integration only: `uv run pytest -m integration`
Run integration parity: `uv run pytest --real-db -m integration`
Run real DB only: `uv run pytest --real-db -m real_db`
Run migrations only: `uv run pytest --real-db -m migration`

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
6. **Resolving both backend fixture chains eagerly** — the default run may start Docker or require optional deps by accident. Use `request.getfixturevalue(...)` in backend selectors.
7. **Per-module container startup for multi-module parity runs** — slower and flakier than a session-scoped container.
8. **Unordered cleanup in real DB fixtures** — foreign-key tables or junction tables can block cleanup unless deleted first.
9. **Assuming in-memory semantics equal production semantics** — parity can fail on soft-delete, totals, missing-row updates, or uniqueness constraints.
10. **Bare query-builder field names in parity tests** — real DB filtering and pagination may require fully qualified fields like `table.column`.
