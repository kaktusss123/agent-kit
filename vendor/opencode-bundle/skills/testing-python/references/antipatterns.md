# Anti-Patterns Deep Dive

## Contents

- 1. Mocking the Service Under Test
- 2. AsyncMock Without spec=
- 3. Session-Scoped Mutable Fixtures
- 4. Inline Faker() Per Test
- 5. Reusable Local Factories in `test_*.py`
- 6. Missing tests/integration/ Directory
- 7. mock.patch Inside Test Body
- 8. skip Without reason
- 9. DB-Dependent Unit Tests
- 10. Config Mutation Without Restoration
- 11. In-Memory Repository Without deepcopy
- 12. Manual try/except for Expected Exceptions
- 13. Coverage-Only Type Wrapper Tests
- 14. Skip Reasons Referencing Agent Artifacts
- 15. Imports Interleaved With Test Logic
- 16. Low-Entropy Test Data and Missing Boundaries
- 17. Boilerplate Test Module Docstrings
- 18. Duplicated Generic Patch Helpers
- 19. Eager Backend Fixture Resolution
- 20. Real DB Cleanup Without FK Order
- 21. Parity Test Data Violates Unique Constraints
- 22. Bare Query-Builder Field Names in Real DB Pagination
- 23. Claiming Parity While In-Memory Semantics Drift
- 24. Scoped Verification for a Global Invariant
- 25. Refactoring on a Red Baseline
- 26. Stale Test Terminology After Migration
- Summary Table

Concrete anti-patterns found in real test suites, with before/after examples and severity ratings.

---

## 1. Mocking the Service Under Test

### ❌ Anti-Pattern

```python
# BAD: You're testing mock behaviour, not real logic
@pytest.fixture
def mock_entity_service():
    return AsyncMock(spec=EntityService)

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

async def test_create(entity_service, mock_entity_repository):
    entity = create_test_entity()
    mock_entity_repository.create.return_value = entity

    result = await entity_service.create(cmd)

    assert result.name == entity.name
    mock_entity_repository.create.assert_awaited_once_with(entity)
```

---

## 2. AsyncMock Without spec=

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

## 5. Reusable Local Factories in test_*.py

### ❌ Anti-Pattern

```python
# BAD: reusable test infrastructure is hidden inside one test module
def _make_flavor(**kwargs) -> Flavor:
    defaults = {
        "id": FlavorID(uuid.uuid4()),
        "name": "test-flavor",
        "status": Status.active,
    }
    defaults.update(kwargs)
    return Flavor.model_construct(**defaults)


def test_map_flavor_sets_identity_fields():
    flavor = _make_flavor(name="small")
    result = map_flavor(flavor)
    assert result.name == "small"
```

### ✅ Fixed

```python
# tests/project/controller/grpc/admin_api/mapper/factories.py
class FlavorFactory(ModelFactory[Flavor]):
    __model__ = Flavor
    __use_examples__ = True


# tests/project/controller/grpc/admin_api/mapper/conftest.py
@pytest.fixture
def flavor_factory() -> type[FlavorFactory]:
    return FlavorFactory


# test_flavor.py
def test_map_flavor_sets_identity_fields(flavor_factory):
    flavor = flavor_factory.build(name="small")
    result = map_flavor(flavor)
    assert result.name == "small"
```

Use `conftest.py` or a dedicated `factories.py` for reusable builders. Keep `test_*.py` focused on scenario setup and assertions.

---

## 6. Missing tests/integration/ Directory

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

## 7. mock.patch Inside Test Body

### ❌ Anti-Pattern

```python
# BAD: Setup mixed with assertion, hard to read
async def test_something():
    with patch("module.dependency", mock_dependency):
        with patch("module.another", mock_another):
            result = await service.do_thing()

    assert result ...

    # What if assertion fails? Patch is still cleaned, but test is messy.
```

### ✅ Fixed

```python
# GOOD: Setup extracted to fixture, test focuses on behaviour
@pytest.fixture
def mock_dependencies():
    with patch("module.dependency", AsyncMock()) as dep, \
         patch("module.another", AsyncMock()) as other:
        yield dep, other

async def test_something(mock_dependencies):
    dep, other = mock_dependencies

    result = await service.do_thing()

    assert result.status == Status.DONE
    dep.process.assert_awaited_once()
```

---

## 8. skip Without reason

### ❌ Anti-Pattern

```python
@pytest.mark.skip  # Why is this skipped?
async def test_create_with_inactive_status():
    ...
```

### ✅ Fixed

```python
@pytest.mark.skip(reason="Not implemented: inactive entity handling (TICKET-123)")
async def test_create_with_inactive_status():
    ...

# Or with a tracking reference:
@pytest.mark.skip(reason="Have to be verified against new protobuf contract")
async def test_update_to_add_inactive():
    ...
```

---

## 9. DB-Dependent Unit Tests

### ❌ Anti-Pattern

```python
# BAD: Test requires real PostgreSQL, slow and flaky
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

async def test_entity_service_create(entity_service, mock_entity_repository):
    mock_entity_repository.create.return_value = Entity(id=EntityID(uuid.uuid4()), name="test")

    result = await entity_service.create(cmd)

    assert result.name == "test"
    mock_entity_repository.create.assert_awaited_once()
```

---

## 10. Config Mutation Without Restoration

### ❌ Anti-Pattern

```python
# BAD: Config change leaks to other tests
async def test_with_feature_enabled():
    config.feature.enabled = True  # Mutates global state
    result = await service.do_thing()
    assert result.is_enabled

# Later test fails because config.feature.enabled is still True
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

async def test_with_feature_enabled(feature_enabled):
    result = await service.do_thing()
    assert result.is_enabled
```

---

## 11. In-Memory Repository Without deepcopy

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

## 12. Manual try/except for Expected Exceptions

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
    with pytest.raises(ValueError, match="Invalid value"):
        parse("invalid")
```

---

## 13. Coverage-Only Type Wrapper Tests

### ❌ Anti-Pattern

```python
# BAD: only checks the runtime base type of a NewType wrapper.
def test_generate_new_cluster_id_returns_valid_id():
    result = generate_new_cluster_id()

    assert isinstance(result, uuid.UUID)
```

### ✅ Fixed

```python
# GOOD: verifies the public contract that consumes the generated ID.
def test_cluster_mapper_serializes_generated_cluster_id(cluster_factory):
    cluster = cluster_factory.build(id=generate_new_cluster_id())

    result = map_cluster_to_proto(cluster)

    assert result.id == str(cluster.id)
```

Standalone smoke tests for ID generators are acceptable only when the generator is itself a public boundary contract or has a documented regression risk.

---

## 14. Skip Reasons Referencing Agent Artifacts

### ❌ Anti-Pattern

```python
@pytest.mark.skip(
    reason="Branch unreachable. See plan-c.yaml blocked_tests for details."
)
def test_unreachable_branch():
    ...
```

### ✅ Fixed

```python
@pytest.mark.skip(
    reason="Product limitation: deleting Pydantic entity state is read-only at runtime. TICKET-123 tracks the branch cleanup."
)
def test_unreachable_branch():
    ...
```

Never reference `docs/agent-testing`, `plan-*.yaml`, capsules, writer reports, or reviewer reports from committed tests.

---

## 15. Imports Interleaved With Test Logic

### ❌ Anti-Pattern

```python
async def test_import_conflict_raises_precondition():
    orch, service = create_orchestrator()

    from project.transfer_models import encode_payload_to_base64

    payload = encode_payload_to_base64(...)
```

### ✅ Fixed

```python
from project.transfer_models import encode_payload_to_base64


async def test_import_conflict_raises_precondition():
    orch, service = create_orchestrator()

    payload = encode_payload_to_base64(...)
```

Inline imports need an explicit exceptional reason. Do not hide dependencies inside arrange logic.

---

## 16. Low-Entropy Test Data and Missing Boundaries

### ❌ Anti-Pattern

```python
cmd.name = "test-component"
cmd.kind = "deployment"
cmd.namespace = "test-ns"
```

### ✅ Fixed

```python
cmd.name = faker.slug()
cmd.kind = "deployment"
cmd.namespace = faker.slug()
```

Use hard-coded literals for semantic constants only. For fields with parsing or validation behavior, add parametrized valid and invalid cases.

---

## 17. Boilerplate Test Module Docstrings

### ❌ Anti-Pattern

```python
"""Tests for admin_api mapper functions."""
```

### ✅ Fixed

Remove the docstring unless it explains a non-obvious test module constraint. One-line test function docstrings are allowed when they clarify behavior.

---

## 18. Duplicated Generic Patch Helpers

### ❌ Anti-Pattern

```python
class DummySessionContextManager:
    async def __aenter__(self):
        return None

    async def __aexit__(self, exc_type, exc, tb):
        return None

    def __call__(self, *args, **kwargs):
        return self
```

### ✅ Fixed

Reuse an existing parent `conftest.py` helper when it patches the target module. Otherwise, move shared helpers or autouse patches to the nearest subtree `conftest.py` after verifying patch targets and fixture scope.

---

## 19. Eager Backend Fixture Resolution

### ❌ Anti-Pattern

```python
@pytest.fixture
def project_repository(in_memory_project_repository, real_project_repository, request):
    if request.config.getoption("--real-db"):
        return real_project_repository
    return in_memory_project_repository
```

### ✅ Fixed

```python
@pytest.fixture
def project_repository(request):
    if request.config.getoption("--real-db"):
        return request.getfixturevalue("real_project_repository")
    return request.getfixturevalue("in_memory_project_repository")
```

The fixed version avoids resolving the unused backend chain. Default runs stay Docker-free even when real DB fixtures import optional dependencies or start containers.

---

## 20. Real DB Cleanup Without FK Order

### ❌ Anti-Pattern

```python
await session.execute(text("DELETE FROM public.parent_table"))
await session.execute(text("DELETE FROM public.child_table"))
```

### ✅ Fixed

```python
await session.execute(text("DELETE FROM public.child_table"))
await session.execute(text("DELETE FROM public.parent_table"))
```

Delete junction and child tables first. Real DB cleanup must follow actual FK direction.

---

## 21. Parity Test Data Violates Unique Constraints

### ❌ Anti-Pattern

```python
cv1 = _make_cluster_version(faker)
cv2 = _make_cluster_version(faker)
cv3 = _make_cluster_version(faker)
```

### ✅ Fixed

```python
cv1 = _make_cluster_version(faker, version=1)
cv2 = _make_cluster_version(faker, version=2)
cv3 = _make_cluster_version(faker, version=3)
```

Reusable factory defaults may be safe in-memory but invalid under real DB uniqueness rules. Parity tests need realistic unique values unless the test explicitly asserts the constraint error.

---

## 22. Bare Query-Builder Field Names in Real DB Pagination

### ❌ Anti-Pattern

```python
OffsetPagination(page_size=10, direction=Direction.ASC, field="version", offset=0)
```

### ✅ Fixed

```python
OffsetPagination(
    page_size=10,
    direction=Direction.ASC,
    field="cluster_version.version",
    offset=0,
)
```

If the underlying query builder expects `table.column`, parity tests must use the same qualified field naming as production queries.

---

## 23. Claiming Parity While In-Memory Semantics Drift

### ❌ Anti-Pattern

```python
# In-memory helper filters deleted rows here,
# but the real repository returns all rows for this method.
result = [p for p in self._store.values() if p.status != ManagementStatus.DELETED]
```

### ✅ Fixed

```python
# Match the production repository contract for this method.
return [deepcopy(p) for p in self._store.values()]
```

Dual-backend tests must validate business behavior, not preserve an accidental in-memory-only rule.

---

## 24. Scoped Verification for a Global Invariant

### ❌ Anti-Pattern

```text
User goal: "No direct X under tests/"
Verification: "No direct X in the files I changed."
```

### ✅ Fixed

```text
Inventory: all tests/ files
Result: every X occurrence listed and classified
```

A repository-wide invariant is not satisfied by a scoped diff check.

---

## 25. Refactoring on a Red Baseline

### ❌ Anti-Pattern

```text
Baseline: relevant tests fail
Action: migrate helpers anyway
Report: remaining failures are pre-existing
```

### ✅ Fixed

```text
Baseline: relevant tests fail
Action: repair baseline first or stop as blocked
```

Refactors and migrations need a green relevant baseline so regressions are attributable.

---

## 26. Stale Test Terminology After Migration

### ❌ Anti-Pattern

```python
def make_entity() -> Entity:
    """Create an Entity via old_constructor."""
    return EntityFactory.build()
```

### ✅ Fixed

```python
def make_entity() -> Entity:
    """Create an Entity with the shared factory."""
    return EntityFactory.build()
```

Stale comments and docstrings teach future tests to copy the old pattern.

---

## Summary Table

| # | Anti-Pattern | Severity | Detection |
|---|-------------|----------|-----------|
| 1 | Mocking service under test | Critical | Review: tests assert on mock behaviour of SUT |
| 2 | No spec= on mock | High | CI grep: `AsyncMock(` without `spec=` |
| 3 | Session-scoped mutable state | High | grep `scope="session"` in conftest |
| 4 | Inline Faker() | Low | grep `Faker()` in test files |
| 5 | Reusable local factories in `test_*.py` | Medium | grep `def _(make|create)|def make_|def create_test_|@pytest.fixture` in changed test modules |
| 6 | Missing tests/integration/ | Medium | glob `tests/integration/` not found |
| 7 | patch inside test body | Low | grep `with patch` in test functions |
| 8 | skip without reason | Low | grep `@pytest.mark.skip\b` (no following text) |
| 9 | DB-dependent unit tests | High | Real DB fixture usage in non-integration tests |
| 10 | Config leak | High | grep `config.* = ` in test functions without fixture |
| 11 | No deepcopy in in-memory repos | Medium | Review in-memory repo implementations |
| 12 | Manual try/except | Low | grep `except ValueError:` in test files |
| 13 | Coverage-only type wrapper tests | Low | Review tests with only `isinstance(result, uuid.UUID)` or equivalent wrapper assertions |
| 14 | Skip references agent artifacts | High | grep `docs/agent-testing\|plan-.*yaml\|writer-report\|review-report` in tests |
| 15 | Inline imports in test logic | Medium | grep indented `from ... import` or `import ...` inside `test_*` functions |
| 16 | Low-entropy test data | Medium | review hard-coded `test-*`, fixed IPs, versions, namespaces |
| 17 | Boilerplate module docstrings | Low | first line starts with `"""Tests for` |
| 18 | Duplicated generic patch helpers | Medium | grep helper class names across `test_*.py` and `conftest.py` |
| 19 | Eager backend fixture resolution | High | backend selector fixture takes both in-memory and real fixtures as eager args |
| 20 | Real DB cleanup without FK order | High | review DELETE order in real DB fixtures |
| 21 | Parity test data violates unique constraints | Medium | repeated factory defaults on unique columns |
| 22 | Bare query-builder field names | Medium | pagination/sort fields omit `table.` prefix where builder requires it |
| 23 | Claimed parity with in-memory semantic drift | High | compare in-memory helpers with production repository behavior |
| 24 | Scoped verification for global invariant | High | compare user goal with whole-tree inventory command |
| 25 | Refactoring on a red baseline | Critical | baseline has relevant failures before writer edits |
| 26 | Stale test terminology after migration | Medium | search changed files for old helper names, comments, and docstrings |
