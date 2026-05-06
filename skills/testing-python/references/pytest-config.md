# Canonical pyproject.toml Configuration

## Contents

- Versioning Note
- Minimum Viable New Project
- Full Dependencies
- Ruff Configuration for Tests
- Enforcing `spec=` on Mocks
- Configuration Decisions
- Check Commands
- Real DB Opt-In Configuration

Copy-paste templates for new projects. Version numbers below are the range this skill was tested against, not a strict requirement.

---

## Versioning Note

**The versions in this reference are what the skill was tested with. They are NOT rules.** Different projects may use different versions. The only hard requirement is the set of packages themselves (pytest, pytest-asyncio, faker, polyfactory, etc.) and the ruff/flake8-pytest-style configuration.

When adopting this skill, check your project's existing versions. Update the skill's tested range if your project uses a newer major version successfully.

---

## Minimum Viable New Project

```toml
[project]
name = "my-service"
requires-python = ">=3.11"

[dependency-groups]
dev = [
    # Core (required)
    "pytest>=8,<10",
    "pytest-asyncio>=0.24,<1",
    "pytest-cov>=6,<10",

    # Quality (required)
    "pytest-deadfixtures>=2,<3",
    "pytest-randomly>=3,<4",
    "pytest-xdist>=3,<4",

    # Test data (required)
    "faker>=25,<40",
    "polyfactory>=2,<3",

    # Linting (required)
    "ruff>=0.5,<1",
    "flake8-pytest-style>=2,<3",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
markers = [
    "integration: backend-agnostic integration tests; runs by default and can rerun with --real-db",
    "real_db: PostgreSQL testcontainer tests, require --real-db",
    "migration: Alembic migration tests, require --real-db",
]

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

## Full Dependencies (with optional additions)

```toml
[dependency-groups]
dev = [
    # ============================================================
    # Core (required)
    # ============================================================
    "pytest>=8,<10",
    "pytest-asyncio>=0.24,<1",
    "pytest-cov>=6,<10",

    # ============================================================
    # Quality (required)
    # ============================================================
    "pytest-deadfixtures>=2,<3",
    "pytest-randomly>=3,<4",
    "pytest-xdist>=3,<4",

    # ============================================================
    # Test data (required)
    # ============================================================
    "faker>=25,<40",
    "polyfactory>=2,<3",

    # ============================================================
    # Recommended (install by default, remove if not needed)
    # ============================================================
    "pytest-sugar>=1,<2",

    # ============================================================
    # Optional
    # ============================================================
    "pytest-mock>=3,<5",             # Only if using mocker fixture
    "freezegun>=1,<2",               # Freeze time in tests
    "testcontainers>=4,<5",          # Real DB parity and DB-specific containers
    "pytest-alembic>=0.11,<1",       # Migration tests
    "pytest-async-sqlalchemy>=0.2,<1", # Async SQLAlchemy
    "hypothesis>=6,<7",              # Property-based testing
    "pytestarch>=3,<4",              # Architecture testing

    # ============================================================
    # Linting (required)
    # ============================================================
    "ruff>=0.5,<1",
    "flake8-pytest-style>=2,<3",
]
```

---

## ruff Configuration for Tests

```toml
[tool.ruff.lint]
select = [
    "PT",      # flake8-pytest-style
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

### What These Rules Enforce

| Rule | Before | After |
|------|--------|-------|
| PT001 | `@pytest.fixture()` | `@pytest.fixture` |
| PT003 | `@pytest.mark.skip()` | `@pytest.mark.skip` |
| PT006 | names count ≠ values count | Error at lint time |
| parametrize-names-type | `("a", "b")` not allowed | Must be `"a,b"` (CSV) |

### Why S101 and SLF001 are allowed in tests

- `S101` (`assert` usage): Tests must use `assert`
- `SLF001` (private access): Occasionally needed for private method mocking or state verification

---

## Enforcing `spec=` on Mocks

`AsyncMock(spec=InterfaceClass)` is mandatory (see SKILL.md R4). To enforce mechanically, add a conftest check or CI script:

### Option A: conftest hook (run-time warning)

```python
# tests/conftest.py
import unittest.mock
from unittest.mock import AsyncMock

_original_init = AsyncMock.__init__

def _require_spec(self, *args, **kwargs):
    if "spec" not in kwargs and not args:
        import warnings
        warnings.warn(
            f"AsyncMock created without spec= in {__file__}. "
            "Add spec=InterfaceClass for type safety.",
            RuntimeWarning,
        )
    _original_init(self, *args, **kwargs)

AsyncMock.__init__ = _require_spec
```

### Option B: CI grep check

```bash
# Fail CI if AsyncMock() used without spec= in test files
! rg 'AsyncMock\(' tests/ --no-filename | rg -v 'spec=' && \
  echo "❌ Found AsyncMock() without spec=" && exit 1
```

---

## Configuration Decisions

### Why `asyncio_mode = "auto"`?

Without it, every async test needs `@pytest.mark.asyncio`. Auto mode detects `async def` automatically.

### Why `asyncio_default_fixture_loop_scope = "function"`?

Each test gets its own event loop. Prevents state leaks. `"session"` scope causes hard-to-debug leaks.

### Why `pytest-deadfixtures`?

Detects fixtures defined but never used. Catches conftest.py rot.

### Why `pytest-randomly`?

Randomizes execution order. Exposes hidden test dependencies. Must be paired with proper isolation.

### Why `pytest-xdist`?

Parallel test execution via `pytest -n auto`. Each worker gets a different random seed.

---

## Check Commands

```bash
# Validate config
uv run pytest --collect-only

# Check lint
ruff check tests/

# Find unused fixtures
uv run pytest --dead-fixtures

# Reproduce a random failure
uv run pytest --randomly-seed=<seed-from-failure>

# Check for mocks without spec=
rg 'AsyncMock\(' tests/ --no-filename | rg -v 'spec='
```

---

## Real DB Opt-In Configuration

Register `real_db` and `migration` markers, but do not exclude all integration tests by default. In-memory integration tests are fast and should run with ordinary `uv run pytest`; only PostgreSQL/testcontainer tests are opt-in.

```toml
[tool.pytest.ini_options]
markers = [
    "integration: backend-agnostic integration tests; runs by default and can rerun with --real-db",
    "real_db: PostgreSQL testcontainer tests, require --real-db",
    "migration: Alembic migration tests, require --real-db",
]
```

Preferred commands:

```bash
# Agent and local default; must not start Docker
uv run pytest

# Fast backend-agnostic integration path
uv run pytest -m integration

# CI/manual parity rerun for the same integration tests
uv run pytest --real-db -m integration

# CI/manual PostgreSQL-specific verification
uv run pytest --real-db -m real_db

# CI/manual migration verification
uv run pytest --real-db -m migration
```

Do not add `-m "not integration"` to default `addopts` unless the project explicitly wants unit-only default runs. That would hide in-memory integration coverage from agents and local developers.

Backend-agnostic tests should usually use the `integration` marker only. Reserve `real_db` for PostgreSQL-specific assertions and `migration` for migration coverage.

For coverage commands, prefer the repository's default `pytest-cov` workflow when it already works for broad package coverage, for example `--cov=package_name`. For narrow scopes, prefer path-based values such as `--cov=package_name/subpackage` instead of dotted import names such as `--cov=package_name.subpackage`. Coverage treats directory values as source directories and non-directory values as importable names.

If a project also uses `coverage run --timid`, verify that its active coverage config is compatible with `PyTracer`. Configs that enable unsupported concurrency modes, such as `greenlet`, need a dedicated config file or explicit `--rcfile` override for `coverage run` workflows.
