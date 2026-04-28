# Anti-Patterns Deep Dive

Concrete anti-patterns found in existing production projects, with before/after examples.

---

## 1. Mocking the Service Under Test

### ❌ Anti-Pattern

```python
# BAD: You're testing mock behavior, not real logic
@pytest.fixture
def mock_entity_service():
    return AsyncMock(spec=EntityService)

@pytest.mark.asyncio
async def test_create(mock_entity_service):
    mock_entity_service.create.return_value = Entity(...)

    result = await mock_entity_service.create(cmd)
    assert result is not None
```

### ✅ Fixed

```python
# GOOD: Real service, only dependencies mocked
@pytest.fixture
def mock_entity_repository():
    return AsyncMock(spec=EntityRepository)

@pytest.fixture
def entity_service(mock_entity_repository):
    return EntityService(repository=mock_entity_repository)

@pytest.mark.asyncio
async def test_create(entity_service, mock_entity_repository):
    entity = create_test_entity()
    mock_entity_repository.create.return_value = entity

    result = await entity_service.create(cmd)

    assert result.name == entity.name
    mock_entity_repository.create.assert_awaited_once_with(entity)
```

---

## 2. MagicMock/AsyncMock Without spec=

### ❌ Anti-Pattern

```python
# BAD: Silent typos, no interface contract
mock_repo = AsyncMock()
mock_repo.cretae.return_value = entity  # typo: "cretae" instead of "create"
# Test passes because AsyncMock accepts any attribute
```

### ✅ Fixed

```python
# GOOD: Type-safe, catches typos at test setup
mock_repo = AsyncMock(spec=EntityRepository)
mock_repo.cretae.return_value = entity  # AttributeError: spec has no 'cretae'
```

---

## 3. Session-Scoped Mutable Fixtures

### ❌ Anti-Pattern

```python
# BAD: State leaks between tests, test order matters
@pytest.fixture(scope="session")
def entity_list():
    return []

def test_adds_entity(entity_list):
    entity_list.append(Entity(name="test"))
    assert len(entity_list) == 1  # Passes

def test_expects_empty(entity_list):
    assert len(entity_list) == 0  # FAILS! List has 1 element from previous test
```

### ✅ Fixed

```python
# GOOD: Fresh list per test (default function scope)
@pytest.fixture
def entity_list():
    return []

# OR: Use factory fixture for complex shared setup
@pytest.fixture
def entity_factory(faker):
    class Factory:
        def build(self, **kwargs):
            return Entity(name=faker.word(), **kwargs)
    return Factory()
```

---

## 4. Inline Faker() Per Test

### ❌ Anti-Pattern

```python
# BAD: New Faker instance every test — wasted setup
def test_user_email():
    faker = Faker()
    user = User(email=faker.email())

def test_user_name():
    faker = Faker()  # Another instance
    user = User(name=faker.name())
```

### ✅ Fixed

```python
# GOOD: One session-scoped instance
# tests/conftest.py
@pytest.fixture(scope="session")
def faker():
    return Faker()

def test_user_email(faker):
    user = User(email=faker.email())

def test_user_name(faker):
    user = User(name=faker.name())
```

---

## 5. Missing tests/integration/ Directory

### ❌ Anti-Pattern

```
tests/
├── conftest.py
├── test_services.py  # Has integration tests mixed with unit tests
└── test_something.py
```

### ✅ Fixed

```
tests/
├── conftest.py
├── integration/
│   ├── __init__.py
│   ├── conftest.py
│   ├── repositories/
│   │   └── in_memory.py
│   └── test_create_entity_flow.py
└── domain/
    └── services/
        └── test_entity_service.py  # Unit tests only
```

---

## 6. mock.patch Inside Test Body

### ❌ Anti-Pattern

```python
# BAD: Setup mixed with assertion, hard to read
@pytest.mark.asyncio
async def test_something():
    with patch("module.dependency", mock_dependency):
        with patch("module.another", mock_another):
            result = await service.do_thing()

    assert result ...

    # What if assertion fails? Patch is still cleaned, but test is messy.
```

### ✅ Fixed

```python
# GOOD: Setup extracted to fixture, test focuses on behavior
@pytest.fixture
def mock_dependencies():
    with patch("module.dependency", AsyncMock()) as dep, \
         patch("module.another", AsyncMock()) as other:
        yield dep, other

@pytest.mark.asyncio
async def test_something(mock_dependencies):
    dep, other = mock_dependencies

    result = await service.do_thing()

    assert result.status == Status.DONE
    dep.process.assert_awaited_once()
```

---

## 7. skip Without reason

### ❌ Anti-Pattern

```python
@pytest.mark.skip  # Why is this skipped?
async def test_create_trino_with_inactive_catalog():
    ...
```

### ✅ Fixed

```python
@pytest.mark.skip(reason="Not implemented: inactive catalog handling (DP-1234)")
async def test_create_trino_with_inactive_catalog():
    ...

# Or with a tracking reference:
@pytest.mark.skip(reason="Have to be verified against new protobuf contract")
async def test_update_trino_to_add_inactive_catalog():
    ...
```

---

## 8. DB-Dependent Unit Tests

### ❌ Anti-Pattern

```python
# BAD: Test requires real PostgreSQL, slow and flaky
@pytest.mark.asyncio
async def test_entity_service_create():
    # Uses real DB connection!
    service = EntityService(repository=RealPostgresRepository())
    result = await service.create(Entity(name="test"))

    assert result.id is not None

    # Must clean up after test — another source of flakiness
    await real_repo.delete(result.id)
```

### ✅ Fixed

```python
# GOOD: Mock at repository boundary, fast and deterministic
@pytest.fixture
def mock_entity_repository():
    return AsyncMock(spec=EntityRepository)

@pytest.fixture
def entity_service(mock_entity_repository):
    return EntityService(repository=mock_entity_repository)

@pytest.mark.asyncio
async def test_entity_service_create(entity_service, mock_entity_repository):
    mock_entity_repository.create.return_value = Entity(id=EntityID(uuid.uuid4()), name="test")

    result = await entity_service.create(cmd)

    assert result.name == "test"
    mock_entity_repository.create.assert_awaited_once()
```

---

## 9. Config Mutation Without Restoration

### ❌ Anti-Pattern

```python
# BAD: Config change leaks to other tests
@pytest.mark.asyncio
async def test_with_feature_enabled():
    config.feature.enabled = True  # Mutates global state
    result = await service.do_thing()
    assert result.is_enabled

# Later test fails because config.feature.enabled is still True
@pytest.mark.asyncio
async def test_with_feature_disabled():
    # config.feature.enabled might be True here!
    result = await service.do_thing()
    assert not result.is_enabled  # Flaky!
```

### ✅ Fixed

```python
# GOOD: Save, yield modified, restore in finally
@pytest.fixture
def feature_enabled():
    original = config.feature.enabled
    try:
        config.feature.enabled = True
        yield
    finally:
        config.feature.enabled = original

@pytest.mark.asyncio
async def test_with_feature_enabled(feature_enabled):
    result = await service.do_thing()
    assert result.is_enabled
```

---

## 10. In-Memory Repository Without deepcopy

### ❌ Anti-Pattern

```python
# BAD: Tests can mutate stored objects, leaking state
class InMemoryRepo:
    def __init__(self):
        self._store: dict = {}

    async def create(self, entity: Entity) -> Entity:
        self._store[entity.id] = entity  # Stores reference, not copy
        return entity

    async def get(self, entity_id: EntityID) -> Entity:
        return self._store.get(entity_id)  # Returns same reference

# Test A: modifies returned entity
entity = await repo.create(Entity(name="original"))
entity.name = "modified"  # Mutates stored object!
assert entity.name == "modified"

# Test B: expects original state
entity = await repo.get(entity_id)
assert entity.name == "original"  # FAILS! Name is "modified"
```

### ✅ Fixed

```python
# GOOD: deepcopy on read and write
from copy import deepcopy

class InMemoryRepo:
    def __init__(self):
        self._store: dict = {}

    async def create(self, entity: Entity) -> Entity:
        self._store[entity.id] = deepcopy(entity)
        return deepcopy(entity)

    async def get(self, entity_id: EntityID) -> Entity | None:
        entity = self._store.get(entity_id)
        return deepcopy(entity) if entity else None
```

---

## 11. Manual try/except for Expected Exceptions

### ❌ Anti-Pattern

```python
# BAD: Test passes even if no exception is raised (missing assert False)
def test_parse_invalid():
    try:
        parse("invalid")
        assert False, "Expected ValueError"  # Easy to forget!
    except ValueError:
        pass  # Silently passes if no exception and forgot assert False
```

### ✅ Fixed

```python
# GOOD: pytest.raises — explicit and safe
def test_parse_invalid():
    with pytest.raises(ValueError, match="Invalid memory string"):
        parse("invalid")
```

---

## Summary Table

| # | Anti-Pattern | Severity | Detection |
|---|-------------|----------|-----------|
| 1 | Mocking service under test | Critical | Review: tests assert on mock behavior of SUT |
| 2 | No spec= on mock | High | Linter could catch (ruff custom rule) |
| 3 | Session-scoped mutable state | High | grep `scope="session"` in conftest |
| 4 | Inline Faker() | Low | grep `Faker()` in test files |
| 5 | Missing tests/integration/ | Medium | glob `tests/integration/` not found |
| 6 | patch inside test body | Low | grep `with patch` in test functions |
| 7 | skip without reason | Low | grep `@pytest.mark.skip\b` (no following text) |
| 8 | DB-dependent unit tests | High | Check for real DB fixture usage in non-integration tests |
| 9 | Config leak | High | grep config.* = in test functions without try/finally |
| 10 | No deepcopy in in-memory repos | Medium | Review in-memory repo implementations |
| 11 | Manual try/except | Low | grep `except ValueError:` in test files |
