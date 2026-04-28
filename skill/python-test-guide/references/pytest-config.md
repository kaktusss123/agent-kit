# Canonical pyproject.toml Configuration

Copy-paste template for new projects. Explanations for each setting.

---

## Full [tool.pytest.ini_options]

```toml
[tool.pytest.ini_options]
# Test discovery
testpaths = ["tests"]
pythonpath = ["."]

# Async support — preferred: auto mode (no @pytest.mark.asyncio needed)
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"

# Warnings
filterwarnings = [
    "ignore:datetime.datetime.utcnow\\(\\) is deprecated:DeprecationWarning",
]
```

---

## Full Dev Dependencies

```toml
[dependency-groups]
dev = [
    # ============================================================
    # Core pytest + plugins
    # ============================================================
    "pytest>=8.4,<10",
    "pytest-asyncio>=0.24,<1",
    "pytest-cov>=6.0,<9",
    "pytest-mock>=3.15,<5",         # Only if using mocker fixture

    # ============================================================
    # Quality (non-optional)
    # ============================================================
    "pytest-deadfixtures>=2.2,<3",   # Detect unused fixtures
    "pytest-randomly>=3.15,<4",      # Random test order
    "pytest-xdist>=3.6,<4",          # Parallel execution (-n auto)
    "pytest-sugar>=1.0,<2",          # Better output formatting

    # ============================================================
    # Test data generation (non-optional)
    # ============================================================
    "faker>=30,<40",
    "polyfactory>=2.16,<3",          # Optional: Pydantic model factories
    "freezegun>=1.5,<2",             # Optional: freeze time in tests

    # ============================================================
    # Integration testing (optional)
    # ============================================================
    "testcontainers>=4.0,<5",        # Real DB containers
    "pytest-alembic>=0.11,<1",       # Migration tests
    "pytest-async-sqlalchemy>=0.2,<1", # Async SQLAlchemy tests

    # ============================================================
    # Fuzzing (optional)
    # ============================================================
    "hypothesis>=6.150,<7",

    # ============================================================
    # Architecture testing (planned adoption)
    # ============================================================
    "pytestarch>=3.1,<4",

    # ============================================================
    # Linting (non-optional)
    # ============================================================
    "ruff>=0.5,<1",
    "flake8-pytest-style>=2.0,<3",
]
```

---

## Full ruff Configuration for Tests

```toml
[tool.ruff.lint]
select = [
    "PT",      # flake8-pytest-style
    "S101",    # assert usage (suppressed in tests/)
]

[tool.ruff.lint.flake8-pytest-style]
pytest-fixture-no-parentheses = true
pytest-mark-no-parentheses = true
pytest-parametrize-names-type = "csv"

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = [
    "S101",    # assert is expected in tests
    "SLF001",  # Private member access allowed in tests
]
```

---

## Minimal New Project Config

For a brand new project, the minimum viable pyproject.toml test section:

```toml
[project]
name = "my-service"
requires-python = ">=3.11"

[dependency-groups]
dev = [
    "pytest>=8.4,<10",
    "pytest-asyncio>=0.24,<1",
    "pytest-cov>=6.0,<9",
    "pytest-deadfixtures>=2.2,<3",
    "pytest-randomly>=3.15,<4",
    "pytest-xdist>=3.6,<4",
    "faker>=30,<40",
    "ruff>=0.5,<1",
    "flake8-pytest-style>=2.0,<3",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"

[tool.ruff.lint]
select = ["PT"]

[tool.ruff.lint.flake8-pytest-style]
pytest-fixture-no-parentheses = true
pytest-mark-no-parentheses = true
pytest-parametrize-names-type = "csv"

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["S101", "SLF001"]
```

---

## Configuration Decision Explanations

### Why `asyncio_mode = "auto"`?

Without it, every async test function needs `@pytest.mark.asyncio`. With auto mode, pytest detects `async def` test functions and handles event loop automatically. One less decorator to forget.

### Why `asyncio_default_fixture_loop_scope = "function"`?

Ensures each test gets its own event loop. Prevents event loop state leaks between tests (open connections, pending tasks). `"session"` scope is tempting for performance but causes hard-to-debug leaks.

### Why `pytest-deadfixtures`?

Detects fixtures that are defined but never used. Catches rot in conftest.py as code evolves. Example output:

```
ERROR: Dead fixtures found:
  - mock_old_service (conftest.py:42): Defined but never requested by any test
```

### Why `pytest-randomly`?

Randomizes test execution order. Exposes hidden test dependencies (tests that pass only because a previous test set up global state). Must be combined with proper isolation (no session-scoped mutable fixtures).

### Why `pytest-xdist`?

Parallel test execution via `-n auto`. Not required for CI but strongly recommended for developer experience. Combined with `pytest-randomly`, each worker gets a different random seed.

### Why `pytest-parametrize-names-type = "csv"`?

Enforces consistent parametrize syntax:

```python
# Enforced (CSV)
@pytest.mark.parametrize("a,b,expected", [...])

# Also accepted but less common
@pytest.mark.parametrize(("a", "b", "expected"), [...])
```

### Why `flake8-pytest-style`?

Catches pytest-specific anti-patterns at lint time:

- `PT001`: `@pytest.fixture()` used with empty parens
- `PT003`: `@pytest.mark.skip()` used with empty parens  
- `PT006`: Parametrize values not matching number of names
- `PT027`: `@pytest.mark.asyncio` on non-async function

### Why `S101` and `SLF001` disabled in tests?

- `S101`: `assert` is expected and encouraged in tests
- `SLF001`: `obj._private_attr` access is sometimes necessary for state verification or private method mocking (e.g., `orchestrator._Orchestrator__start_workflow`)

---

## Checking Current Configuration

To validate an existing project's config against this standard:

```bash
# Check pytest config
python -m pytest --collect-only 2>&1 | head -20

# Check ruff config
ruff check tests/

# Check for unused fixtures
python -m pytest --dead-fixtures

# Check random seed (for reproducing failures)
python -m pytest --randomly-seed=42
```
