# Fixture Catalog

## Contents

- 1. Faker Fixture
- 2. Creator Factory Fixture
- 3. Factory Placement
- 4. Config Override Fixture
- 5. gRPC Context Mock
- 6. Split conftest Package
- 7. Polyfactory ModelFactory
- 8. Dummy Async Context Manager
- 9. Hypothesis Profile
- Fixture Scope Decision Tree

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

## 3. Factory Placement (REQUIRED)

Reusable factories and fixture builders are part of test infrastructure, not individual test scenarios. Place them where pytest can discover and reuse them without copying helper functions across `test_*.py` files.

| Scope | Placement | Contents |
|-------|-----------|----------|
| Global | `tests/conftest.py` | `faker`, environment patches, shared plugin setup |
| Domain/unit | nearest `tests/<pkg>/<mod>/conftest.py` | mock dependency fixtures, Polyfactory fixtures, imported local factories |
| Dedicated factories | `tests/<pkg>/<mod>/factories.py` | Polyfactory classes imported by nearby `conftest.py` |
| Integration | `tests/integration/conftest.py` | in-memory repositories, factory overrides, cache clearing |

```python
# tests/project/controller/grpc/admin_api/mapper/factories.py
from polyfactory.factories.pydantic_factory import ModelFactory


class FlavorFactory(ModelFactory[Flavor]):
    __model__ = Flavor
    __use_examples__ = True
```

```python
# tests/project/controller/grpc/admin_api/mapper/conftest.py
@pytest.fixture
def flavor_factory() -> type[FlavorFactory]:
    return FlavorFactory
```

Do not add reusable `_make_*`, `make_*`, `create_test_*`, or `@pytest.fixture` definitions directly to `test_*.py` files. A small one-off object created inside a single test function is acceptable.

---

## 4. Config Override Fixture (REQUIRED for config tests)

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

## 5. gRPC Context Mock (RECOMMENDED)

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

## 6. Split conftest Package (ADVANCED)

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

## 7. Polyfactory ModelFactory (REQUIRED for reusable model factories)

```python
from polyfactory.factories.pydantic_factory import ModelFactory

class EntityModelFactory(ModelFactory[Entity]):
    __model__ = Entity
    __use_examples__ = True

entity = EntityModelFactory.build(status="active")
```

Use for reusable Pydantic/domain model construction. Keep one-off `model_construct()` setup inside a single test function only when it is not reused.
If `polyfactory` is missing from dev/test dependencies, add it there before introducing reusable model factories.

---

## 8. Dummy Async Context Manager (ADVANCED)

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

### Placement rule for reusable patch helpers

Do not duplicate generic helper classes in multiple `test_*.py` files. Before moving a helper, verify the existing parent `conftest.py` hierarchy and the exact modules each patch targets.

Use this placement order:

1. If a parent `conftest.py` already defines the helper and patches the target module, reuse it.
2. If several tests in one subtree need the same helper, place the helper or autouse patch in the nearest subtree `conftest.py`.
3. If only one test module needs a module-specific patch, keep the patch local but import any generic helper from shared test infrastructure.
4. If the helper behavior differs per module, do not centralize it until the differences are explicit in the plan.

Run collection after moving patch helpers because autouse fixture scope changes can affect unrelated tests.

---

## 9. Hypothesis Profile (OPTIONAL)

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
