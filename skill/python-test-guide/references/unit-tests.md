# Unit Test Patterns

How to write isolated unit tests. All dependencies are mocked.

Test files go in `tests/<package>/<module>/` — mirror the source structure.

---

## Core Pattern: Real Service + Mocked Dependencies

```python
# tests/<package>/<module>/conftest.py
import pytest
from unittest.mock import AsyncMock

@pytest.fixture
def mock_entity_repository() -> AsyncMock:
    mock = AsyncMock(spec=EntityRepository)
    mock.create.return_value = Entity.model_construct(
        id=EntityID(uuid.uuid4()), name="test"
    )
    return mock

@pytest.fixture
def entity_service(mock_entity_repository: AsyncMock) -> EntityService:
    """Real service under test with mocked repository."""
    return EntityService(repository=mock_entity_repository)
```

**Why:** The service is the system under test. Only its dependencies are mocked.

---

## Mocking Rules

### Always use `spec=` on AsyncMock

```python
# GOOD — AttributeError on typos
mock_repo = AsyncMock(spec=EntityRepository)

# BAD — silently creates any attribute
mock_repo = AsyncMock()
mock_repo.cretae.return_value = None  # typo never caught
```

### What to mock vs not

| Mock | Don't mock |
|------|-----------|
| Repositories (async) | The service/class under test |
| External API clients | Domain models/entities |
| gRPC channel/client | Pydantic validators |
| DB session (unit tests) | Orchestrator under test |

### Mock verification

```python
# Preferred: assert_awaited_once / assert_awaited_once_with
mock_repo.create.assert_awaited_once_with(expected_entity)

# Call args inspection:
call_kwargs = mock_repo.update.call_args.kwargs
assert call_kwargs["entity_id"] == expected_id

# Batch operation verification:
assert mock_service.start_workflow.called
```

### Creating mock objects

```python
# Simple mock with attributes
mock_op = MagicMock()
mock_op.id = uuid.uuid4()

# gRPC context mock
context = MagicMock()
context.invocation_metadata.return_value = [
    ("user_id", str(uuid.uuid4())),
    ("project_id", str(uuid.uuid4())),
]
```

---

## Async Testing

### Configuration

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
```

With auto mode, write `async def test_*` — no `@pytest.mark.asyncio` needed.

### Async test

```python
async def test_create_entity(entity_service, mock_repo):
    entity = Entity.model_construct(id=EntityID(uuid.uuid4()), name="test")
    mock_repo.create.return_value = entity

    result = await entity_service.create(name="test")

    assert result.id == entity.id
    mock_repo.create.assert_awaited_once()
```

### Async fixtures

```python
import pytest_asyncio

@pytest_asyncio.fixture
async def seeded_entity(entity_service):
    return await entity_service.create(name="seed")
```

### AsyncMock verification

```python
mock_repo.create.assert_awaited_once()
mock_repo.get_by_id.assert_awaited_once_with(entity_id)
# NOT assert_called_once() — use assert_awaited_* for async mocks
```

---

## Parametrization

| Scenario | Parametrize? |
|----------|-------------|
| Same logic, different inputs | Yes |
| Status-dependent behaviour | Yes |
| Validation boundaries | Yes |
| Two independent dimensions | Nested parametrize |
| Distinct behaviours | Separate functions |
| Complex multi-step setups | Separate functions |

### Simple parametrize

```python
@pytest.mark.parametrize(
    "input_value,expected",
    [
        ("0", 0),
        ("123", 123),
        ("1K", 1024),
        ("2K", 2048),
        ("3M", 3_145_728),
        ("1G", 1_073_741_824),
    ],
)
async def test_parse(input_value, expected):
    assert parse_value(input_value) == expected
```

### With exception expectations

```python
from contextlib import nullcontext as does_not_raise

@pytest.mark.parametrize(
    "status,expectation,match",
    [
        (Status.RUNNING, does_not_raise(), None),
        (Status.CREATING, pytest.raises(Error), "not allowed"),
    ],
)
async def test_validate(status, expectation, match):
    with expectation as exc:
        await validate(status)
    if match:
        assert match in str(exc.value)
```

`does_not_raise()` is `contextlib.nullcontext` — it just lets the test proceed.

### Nested parametrize (matrix)

```python
@pytest.mark.parametrize("variant_a", [
    {"type": "x"},
    {"type": "y", "extra": "z"},
])
@pytest.mark.parametrize("variant_b", [
    {"mode": "fast"},
    {"mode": "precise"},
])
async def test_matrix(variant_a, variant_b):
    config = {**variant_a, **variant_b}
    result = build_config(config)
    assert result.type == variant_a["type"]
    assert result.mode == variant_b["mode"]
```

---

## Test Data Generation

### Faker (required)

```python
@pytest.fixture(scope="session")
def faker() -> Faker:
    return Faker()

def test_something(faker):
    name = faker.word()
    email = faker.email()
```

### model_construct() for Pydantic v2 models

```python
entity = Entity.model_construct(
    id=EntityID(uuid.uuid4()),
    name=faker.word(),
    status=EntityStatus.active,
)
```

`model_construct()` is a Pydantic v2 method that creates a model instance **without running validators**. This makes tests faster and isolates them from unrelated validation rules. Not applicable to dataclasses or attrs.

### Helper factory functions

```python
def create_test_entity(
    entity_id: uuid.UUID | None = None,
    status: EntityStatus = EntityStatus.ACTIVE,
) -> Entity:
    return Entity(
        id=EntityID(entity_id or uuid.uuid4()),
        name=f"test-{faker.word()}",
        status=status,
    )
```

### Polyfactory (optional)

```python
from polyfactory.factories.pydantic_factory import ModelFactory

class EntityFactory(ModelFactory[Entity]):
    __model__ = Entity
    __use_examples__ = True

entity = EntityFactory.build(status="active")
```

Use for complex nested model trees. `model_construct()` + faker suffices for most cases.

### Hypothesis (optional — property-based)

```python
from hypothesis import given, settings, strategies as st

settings.register_profile("production", max_examples=1024)

@given(
    entity_id=st.uuids(version=4),
    name=st.text(min_size=4, max_size=63),
    status=st.sampled_from(StatusEnum),
)
def test_roundtrip(entity_id, name, status):
    proto = EntityProto(id=str(entity_id), name=name, status=status)
    result = map_proto_to_entity(proto)
    assert result.id == EntityID(entity_id)
```

Use for: mapper roundtrips, parsers (verify no crash on any input), validator invariants.

---

## Testing Time-Dependent Code

### Freezing time with freezegun

```python
from freezegun import freeze_time

@freeze_time("2025-01-15 12:00:00")
def test_entity_created_at_is_now():
    entity = Entity(name="test")
    assert entity.created_at == datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)

# As decorator on async function:
@freeze_time("2025-01-15")
async def test_expiry_check(entity_service):
    entity = await entity_service.create(name="test")
    assert not entity.is_expired()
```

### Testing retry behaviour

```python
async def test_retries_on_transient_error(mock_client):
    mock_client.call.side_effect = [
        TransientError("timeout"),
        TransientError("timeout"),
        Entity(id=EntityID(uuid.uuid4())),  # succeeds on 3rd attempt
    ]

    result = await entity_service.fetch_with_retry(entity_id)

    assert result is not None
    assert mock_client.call.call_count == 3
```

### Clock injection for time-dependent logic

```python
class Clock:
    """Injectable clock for deterministic time-dependent tests."""
    def now(self) -> datetime:
        return datetime.now(timezone.utc)

class TestClock(Clock):
    def __init__(self, frozen: datetime):
        self._frozen = frozen
    def now(self) -> datetime:
        return self._frozen

# In test:
clock = TestClock(datetime(2025, 1, 15, tzinfo=timezone.utc))
entity = Entity(name="test", clock=clock)
assert entity.age_in_days() == 0
```

---

## Assertion Style

```python
# Plain assertions
assert result.status == EntityStatus.active
assert len(results) == 3
assert result is not None

# pytest.raises with match
with pytest.raises(ValueError, match="Invalid value"):
    parse("bad_input")

# Inspecting exception attributes
with pytest.raises(ValidationError) as exc:
    validate(input)
assert "field_name" in str(exc.value)

# Mock verification
mock_repo.create.assert_awaited_once_with(expected)
assert mock_repo.delete.called
```

**Don't:** `self.assertEqual()` (unittest style), manual `try/except` for expected exceptions, bare `assert result` without context.

---

## Test Functions vs Classes

**Prefer module-level functions:**

```python
async def test_create_entity(entity_service, mock_repo):
    ...

async def test_get_entity_not_found(entity_service, mock_repo):
    ...
```

**Use classes only for grouping related tests that share setup:**

```python
class TestParsing:
    @pytest.mark.parametrize("input,expected", [
        ("0", 0), ("1K", 1024), ("3M", 3_145_728),
    ])
    def test_valid(self, input, expected):
        ...

    @pytest.mark.parametrize("input", ["abc", "-1", ""])
    def test_invalid(self, input):
        with pytest.raises(ValueError):
            parse(input)
```
