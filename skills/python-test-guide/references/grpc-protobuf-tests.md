# gRPC and Protobuf Mapper Tests

Use this reference when testing gRPC handlers, protobuf mappers, and code that converts between protobuf messages and domain/Pydantic models.

## Core rule

Do not use `MagicMock` as mapper input data. Mappers usually read concrete fields and pass values into protobuf or Pydantic constructors. A `MagicMock` attribute can silently become another mock and later fail inside validation or serialization.

## Prefer real data objects

Use the most concrete object that is cheap to construct:

1. Real protobuf messages for protobuf input.
2. Real domain/Pydantic objects with `model_construct()` for domain input.
3. Small helper factories for repeated object graphs.
4. `MagicMock(spec=ClientInterface)` only for external clients or context objects.

```python
def create_test_instance(instance_id: UUID) -> Instance:
    return Instance.model_construct(
        id=InstanceID(instance_id),
        name="test-instance",
        status=Status.running,
    )


def test_map_instance_to_grpc_sets_identity_fields():
    instance_id = uuid.uuid4()
    instance = create_test_instance(instance_id)

    result = map_instance_to_grpc(instance)

    assert result.id == str(instance_id)
    assert result.name == "test-instance"
```

## Mock only boundaries

```python
def test_handler_reads_user_metadata():
    user_id = str(uuid.uuid4())
    context = MagicMock(spec=grpc.aio.ServicerContext)
    context.invocation_metadata.return_value = [("user_id", user_id)]

    result = read_user_id(context)

    assert result == user_id
```

## Forbidden patterns

```python
def test_mapper_bad_input():
    instance = MagicMock()
    instance.id = uuid.uuid4()

    result = map_instance_to_grpc(instance)

    assert result is not None
```

Problems:

- the input is not the real contract;
- missing fields become nested mocks;
- protobuf/Pydantic constructors may fail far away from the setup;
- the assertion does not verify mapper behavior.

## Required mapper assertions

For each mapper test, assert the contract fields that matter:

- identifiers and enum/status conversions;
- optional field presence and absence;
- repeated field lengths and representative contents;
- timestamp/string/UUID formatting;
- error branches for invalid or unsupported input.

Mapper tests may assert multiple fields when they all belong to one output object.
