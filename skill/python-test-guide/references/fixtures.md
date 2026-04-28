# Detailed Fixture Patterns

Expanded fixture catalog with verbatim examples from production projects (deployer, spark-instance, trino-instance, bi-instance).

---

## 1. Faker Fixture (REQUIRED)

```python
# Source: Found in ALL production projects identically
# File: tests/conftest.py

import pytest
from faker import Faker


@pytest.fixture(scope="session")
def faker() -> Faker:
    """Session-scoped Faker instance for deterministic test data."""
    return Faker()
```

**Usage in tests:**

```python
def test_user_creation(faker):
    name = faker.domain_word()
    email = faker.email()
    user_id = faker.uuid4()

    user = User(id=user_id, name=name, email=email)
    assert user.name == name
```

**Rationale:** Session scope ensures one Faker instance per test run. All projects use this exact pattern. `faker.seed_instance(42)` can be added for deterministic test data when needed.

---

## 2. Repository Mock with spec (REQUIRED)

```python
# Source: deployer, trino-instance, all library projects
# File: tests/<domain>/conftest.py

from unittest.mock import AsyncMock
from trino_instance.infrastructure.database.repositories.catalog import CatalogRepository

@pytest.fixture
def mock_catalog_repository() -> AsyncMock:
    """Mocked repository with spec for type checking."""
    mock = AsyncMock(spec=CatalogRepository)
    mock.create_catalog = AsyncMock()
    mock.get_catalog = AsyncMock()
    mock.list_catalogs = AsyncMock()
    mock.delete_catalog = AsyncMock()
    return mock
```

**Usage:**

```python
@pytest.mark.asyncio
async def test_create_catalog(mock_catalog_repository: AsyncMock):
    mock_catalog_repository.create_catalog.return_value = expected_catalog

    result = await service.create(cmd)

    mock_catalog_repository.create_catalog.assert_awaited_once_with(expected_catalog)
    assert result == expected_catalog
```

**Rationale:** `spec=` ensures the mock has the same interface as the real class. If a method is renamed in the source, tests fail at setup time (not silently at runtime). This is the single most important mocking rule.

---

## 3. Real Service with Injected Mock (REQUIRED)

```python
# Source: trino-instance/tests/trino_instance/business_logic/conftest.py

@pytest.fixture
def trino_service(
    mock_trino_repository: AsyncMock,
    mock_catalog_repository: AsyncMock,
) -> TrinoService:
    """Real service with mocked repository dependencies."""
    return TrinoService(
        trino_repository=mock_trino_repository,
        catalog_repository=mock_catalog_repository,
    )
```

**Usage:**

```python
@pytest.mark.asyncio
async def test_create_trino(trino_service: TrinoService, mock_trino_repository: AsyncMock):
    entity = create_test_trino()

    result = await trino_service.create(entity)

    mock_trino_repository.create_trino_base.assert_awaited_once_with(entity)
    assert result.name == entity.name
```

**Why not mock the service:** Mocking the service defeats the purpose — you're testing the mock, not the real logic. The service is the system under test.

---

## 4. Creator Factory Fixture (RECOMMENDED)

```python
# Source: spark-instance/tests/spark_instance/conftest.py
# Pattern: Nested closure returning factory function

@pytest_asyncio.fixture
async def create_spark_job(spark_model, base_image_model):
    service = get_spark_job_service()

    async def _create(fields: dict | None = None):
        async with session_context_manager:
            fields = {
                "executor_memory": "1g",
                "driver_memory": "1g",
                **(fields or {}),
            }
            spark_job_model = SparkJobModelFactory.build(
                spark_id=spark_model.id,
                base_image_id=base_image_model.id,
                **fields,
            )
            return await service.create_job(spark_job_model=spark_job_model)

    return _create
```

**Usage:**

```python
@pytest.mark.asyncio
async def test_create_job_with_custom_memory(create_spark_job):
    job = await create_spark_job(fields={"executor_memory": "4g", "driver_memory": "2g"})

    assert job.executor_memory == "4g"
    assert job.driver_memory == "2g"
```

**Why this pattern:** The outer fixture handles service setup and dependencies. The inner closure provides a clean API: `await create_entity(fields={...})`. The `fields` dict pattern means tests only specify what they need to override.

---

## 5. Config Override Fixture (RECOMMENDED)

```python
# Source: spark-instance/tests/spark_instance/conftest.py

@pytest_asyncio.fixture
async def min_overhead_0m():
    """Reduce min_overhead to 0m for memory calculation tests."""
    from spark_instance.config import config

    original_value = config.spark_common.min_overhead
    try:
        config.spark_common.min_overhead = "0m"
        yield
    finally:
        config.spark_common.min_overhead = original_value
```

**Usage:**

```python
@pytest.mark.asyncio
async def test_memory_without_overhead(min_overhead_0m):
    result = calculate_memory("1g")
    assert result == parse_to_bytes("1g")
```

**Critical:** Always use `try/finally` to restore config. Without it, config mutations leak between tests (even with pytest-randomly, since config is module-level state).

**Variant — fixture chain with composition:**

```python
@pytest_asyncio.fixture
async def max_batch_cancel_job_limit_2():
    from spark_instance.config import config
    original = config.spark_jobs.max_batch_cancel
    try:
        config.spark_jobs.max_batch_cancel = 2
        yield
    finally:
        config.spark_jobs.max_batch_cancel = original
```

---

## 6. autouse DB Session Mock (REQUIRED for integration)

```python
# Source: deployer/tests/integration/conftest.py

@pytest.fixture(autouse=True)
def mock_session_context_manager():
    """Prevent real DB connections in integration tests."""
    mock_cm = AsyncMock()
    mock_cm.__aenter__.return_value = None
    mock_cm.__aexit__.return_value = None
    with patch(
        "deployer.infrastructure.database.connection.session_context_manager",
        mock_cm
    ):
        yield
```

**Alternative — DummySessionContextManager pattern:**

```python
# Source: deployer/tests/business_logic/orchestrator/admin_api/conftest.py

class DummySessionContextManager:
    async def __aenter__(self):
        return None
    async def __aexit__(self, exc_type, exc, tb):
        return None
    def __call__(self, *args, **kwargs):
        return self


@pytest.fixture(autouse=True)
def patch_session_context_manager(monkeypatch: pytest.MonkeyPatch):
    manager = DummySessionContextManager()
    monkeypatch.setattr(addon_version_module, "session_context_manager", manager)
```

---

## 7. gRPC Context Mock (RECOMMENDED)

```python
# Source: trino-instance controller tests

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

**Usage in controller test:**

```python
def test_map_create_catalog_request(
    request: CreateCatalogRequest,
    mock_grpc_context: MagicMock,
):
    cmd = map_request_to_cmd(request=request, context=mock_grpc_context)

    assert cmd.project_id == extract_project_id(mock_grpc_context)
```

---

## 8. Polyfactory ModelFactory (OPTIONAL)

```python
# Source: spark-instance/tests/spark_instance/conftest.py

from polyfactory.factories.pydantic_factory import ModelFactory

class ProductVersionModelFactory(ModelFactory[ProductVersionModel]):
    __model__ = ProductVersionModel

    @classmethod
    def next_semver(cls, last_version: str | None) -> str:
        if not last_version:
            return "1.0.0"
        major, minor, patch = map(int, last_version.split("."))
        patch += 1
        return f"{major}.{minor}.{patch}"

    @classmethod
    def build_semantic(cls, last_version: str, **kwargs) -> ProductVersionModel:
        if "managed_spark_version" not in kwargs:
            kwargs["managed_spark_version"] = cls.next_semver(last_version)
            kwargs["status"] = ProductVersionStatusEnum.ACTIVE
        return super().build(**kwargs)


class SparkModelFactory(ModelFactory[SparkModel]):
    __model__ = SparkModel
    __use_examples__ = True
```

**Alternative — bi-instance module-scoped factory:**

```python
# Source: bi-instance/tests/conftest.py

@register_fixture(scope="module")
class BiFactory(ModelFactory[Bi]):
    __model__ = Bi
    __use_examples__ = True
```

**Decision:** Offer polyfactory as an option but don't force it. Simple tests are fine with `model_construct()` + faker. Use polyfactory when you need complex nested model trees or version-aware generation.

---

## 9. Hypothesis Strategy (OPTIONAL — property-based testing)

```python
# Source: bi-instance/tests/fuzzing/test_hypothesis_map_bi.py

from hypothesis import given, settings, strategies as st

settings.register_profile("production", max_examples=1024)

@given(
    bi_id=st.uuids(version=4),
    name=st.text(min_size=4, max_size=63, alphabet=list(string.ascii_lowercase)),
    description=st.text(min_size=0, max_size=255),
    status=st.sampled_from(StatusEnum),
    cluster_id=st.uuids(version=4),
)
def test_map_bi_protobuf_roundtrip(bi_id, name, description, status, cluster_id):
    proto = BiProto(
        id=str(bi_id),
        name=name,
        description=description,
        status=status,
        cluster_id=str(cluster_id),
    )
    entity = map_protobuf_to_bi(proto)
    assert entity.id == BiID(bi_id)
    assert entity.name == name
    assert entity.status == status
```

**When to use hypothesis:**
- Mapper/protobuf roundtrips (verify bidirectional conversion is lossless)
- Parsers (verify no input causes crash)
- Validators (verify invariants hold for all generated inputs)
- Serialization/deserialization (verify byte-perfect roundtrip)

---

## 10. Event Loop Fixture (LEGACY PATTERN — avoid in new code)

```python
# Source: user-plane-api (decompiled from .pyc)
# This pattern is OBSOLETE with asyncio_mode = "auto"

@pytest.fixture
def event_loop():
    """DEPRECATED: use asyncio_mode='auto' instead."""
    new_event_loop = asyncio.new_event_loop()
    return new_event_loop
```

**Migration:** Replace with `asyncio_mode = "auto"` in `[tool.pytest.ini_options]`.

---

## 11. Shared conftest_dir Package (ADVANCED — for large projects)

```python
# Source: trino-instance
# Structure: tests/conftest_dir/{__init__,catalog,component,context,utils,version}.py

# tests/conftest_dir/__init__.py
from .catalog import mock_catalog_repository
from .component import component_domain
from .context import context_cmd
from .utils import faker
from .version import version_domain

__all__ = ["faker", "mock_catalog_repository", "component_domain", "version_domain", "context_cmd"]

# tests/conftest.py
from .conftest_dir import *  # noqa
```

**When to use:** When conftest.py exceeds ~200 lines. Split by domain concept, not by file.

---

## 12. In-Memory Repository (REQUIRED for integration)

```python
# Source: trino-instance/tests/integration/repositories/catalog.py

class InMemoryCatalogRepository(CatalogRepository):
    """Full interface implementation for integration testing."""

    def __init__(self):
        self._catalogs: dict[UUID, list[Catalog]] = {}
        self._deleted: set[UUID] = set()
        self._trino_catalog_links: dict[UUID, list[CatalogLink]] = {}

    async def create_catalog(self, catalog: Catalog) -> Catalog:
        catalog_copy = deepcopy(catalog)
        trino_id = catalog_copy.trino_id
        if trino_id not in self._catalogs:
            self._catalogs[trino_id] = []
        self._catalogs[trino_id].append(catalog_copy)
        return deepcopy(catalog_copy)

    async def get_catalog(self, catalog_id: CatalogID) -> Catalog | None:
        for trino_id, catalogs in self._catalogs.items():
            for c in catalogs:
                if c.id == catalog_id:
                    return deepcopy(c)
        return None

    def clear(self):
        self._catalogs.clear()
        self._deleted.clear()
        self._trino_catalog_links.clear()
```

**Key rules for in-memory repos:**
1. Must implement ALL methods of the interface (not just the ones used in tests)
2. Must use `deepcopy` on create and return to prevent mutation leaks
3. Must have a `clear()` method for test isolation
4. Must mirror exact semantics of real repository (e.g., `get` returns `None` for missing)

---

## Fixture Scope Decision Tree

```
Does the fixture have state that changes between tests?
├── Yes → function scope (default)
└── No → Does it do I/O or depend on external resources?
    ├── Yes → function scope (default)
    └── No → Is construction expensive? (DB container, compiled model)
        ├── Yes → module or session scope
        └── No → function scope (default)

Is the fixture mutable and shared between tests?
├── Yes → NEVER USE SESSION SCOPE — use factory fixture instead
└── No → session scope OK if stateless
```

**Summary:** Default to function scope. Use session scope ONLY for truly immutable, stateless singletons (like `faker`).
