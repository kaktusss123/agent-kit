# Fixture Catalog

Ready-to-use fixture recipes. Each pattern includes when to use it and why.

---

## 1. Faker Fixture (REQUIRED)

```python
import pytest
from faker import Faker


@pytest.fixture(scope="session")
def faker() -> Faker:
    """Session-scoped Faker instance."""
    return Faker()
```

**Why session scope:** One instance per test run. For deterministic data: `faker.seed_instance(42)`.

---

## 2. Creator Factory Fixture (RECOMMENDED)

When tests need entities persisted through the real service (e.g., with DB session management), use a fixture that returns a factory closure:

```python
import pytest_asyncio

@pytest_asyncio.fixture
async def create_entity(entity_model):
    """Returns a closure for creating test entities through the real service.

    The outer fixture injects dependencies (service, model).
    The inner closure accepts a `fields` dict for per-test overrides.
    """
    service = get_entity_service()  # Real service provided by project factories

    async def _create(fields: dict | None = None):
        async with session_context_manager():  # Async DB session for persistence
            model = EntityModelFactory.build(**(fields or {}))
            return await service.create(model)

    return _create
```

**Usage:**

```python
entity = await create_entity(fields={"name": "custom", "status": "active"})
```

Pattern: outer fixture sets up service and dependencies, inner closure provides `_create(fields=...)` API. Tests only specify overrides. The `fields` dict is merged with defaults so tests are minimal.

---

## 3. Config Override Fixture (REQUIRED for config tests)

```python
@pytest.fixture
def feature_enabled():
    original = config.feature.enabled
    try:
        config.feature.enabled = True
        yield
    finally:
        config.feature.enabled = original
```

**Critical:** Always `try/finally`. Without it, module-level config state leaks between tests even with pytest-randomly.

---

## 4. gRPC Context Mock (RECOMMENDED)

```python
@pytest.fixture
def mock_grpc_context() -> MagicMock:
    context = MagicMock()
    context.invocation_metadata.return_value = [
        ("user_id", str(uuid.uuid4())),
        ("project_id", str(uuid.uuid4())),
    ]
    return context
```

---

## 5. Split conftest Package (ADVANCED)

When `tests/conftest.py` exceeds ~200 lines, split by domain:

```
tests/conftest_dir/
├── __init__.py     # Re-exports all fixtures
├── entity.py       # mock_entity_repository fixture
├── context.py      # context_cmd fixture
└── utils.py        # faker fixture

tests/conftest.py:
    from .conftest_dir import *  # noqa
```

---

## 6. Polyfactory ModelFactory (OPTIONAL)

```python
from polyfactory.factories.pydantic_factory import ModelFactory

class EntityModelFactory(ModelFactory[Entity]):
    __model__ = Entity
    __use_examples__ = True

entity = EntityModelFactory.build(status="active")
```

Use for complex nested model trees. Most tests are fine with `model_construct()` + faker.

---

## 7. Dummy Async Context Manager (ADVANCED)

When you need to mock a `with session_context_manager():` block — a pattern where an async context manager is used as both callable and context manager:

```python
class DummySessionContextManager:
    """Drop-in replacement for an async context manager used as callable.

    Usage: `monkeypatch.setattr(target_module, "session_context_manager", DummySessionContextManager())`
    """
    async def __aenter__(self):
        return None
    async def __aexit__(self, exc_type, exc, tb):
        return None
    def __call__(self, *args, **kwargs):
        return self

@pytest.fixture(autouse=True)
def patch_session(monkeypatch):
    monkeypatch.setattr(target_module, "session_context_manager", DummySessionContextManager())
```

Replace `target_module` with the actual module where `session_context_manager` is used.

---

## 8. Hypothesis Profile (OPTIONAL)

```python
from hypothesis import settings

settings.register_profile("production", max_examples=1024)
```

Strategies are defined per test via `@given(...)`, not as fixtures. See [unit-tests.md](unit-tests.md) for the pattern.

---

## Fixture Scope Decision Tree

```
Does the fixture have mutable state?
├── Yes → function scope (default)
└── No → Is construction expensive?
    ├── Yes → module/session scope
    └── No → function scope (default)

Examples:
  faker()         → session (stateless singleton)
  in_memory_repo() → function (mutable store — clear() between tests)
  migrated_db()   → module (expensive container start)
  entity_service() → function (depends on mock_repo — fresh each test)
```
