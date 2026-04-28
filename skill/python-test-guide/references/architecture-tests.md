# Architecture Test Patterns

Layer-dependency tests using pytestarch. Enforce that your project's import graph matches its intended architecture.

---

## Motivation

As projects grow, imports drift. A service accidentally imports from a controller. Domain logic sneaks a dependency on infrastructure. These violations don't cause runtime errors but erode the architecture over time.

pytestarch catches them mechanically by analyzing the AST.

---

## Canonical Test File

```python
"""Architecture tests for project layering."""
import pytest
from pytestarch import EvaluableArchitecture, Rule, get_evaluable_architecture


@pytest.fixture(scope="module")
def evaluable() -> EvaluableArchitecture:
    """Build import graph for the project."""
    return get_evaluable_architecture(
        root_path=".",         # Project root
        module_path=".",       # Where the package lives
        exclude_external_libraries=True,
    )


class TestArchitecture:
    """Layer dependency rules."""

    def test_services_dont_import_controllers(self, evaluable):
        (Rule()
         .modules_that()
         .are_sub_modules_of("project.business_logic.service")
         .should_not()
         .import_modules_that()
         .are_sub_modules_of("project.controller")
         .assert_applies(evaluable))

    def test_domain_is_independent(self, evaluable):
        """Domain must not depend on business_logic, controller, or infrastructure."""
        domain = Rule().modules_that().are_sub_modules_of("project.domain")

        for layer in ["business_logic", "controller", "infrastructure"]:
            (domain
             .should_not()
             .import_modules_that()
             .are_sub_modules_of(f"project.{layer}")
             .assert_applies(evaluable))
```

---

## Target Architecture Rules

Adapt the package names to your project. The rule format is:

```python
(Rule()
 .modules_that()          # Source: which modules must follow the rule
 .are_sub_modules_of("package.layer_a")
 .should_not()             # or .should()
 .import_modules_that()   # Target: what they must not import
 .are_sub_modules_of("package.layer_b")
 .assert_applies(evaluable))
```

### Standard rule set for a layered project

Replace `project` with your package name. Implement these rules in `tests/architecture/test_layering.py`:

```python
class TestArchitecture:

    def test_services_dont_import_controllers(self, evaluable):
        """Services are called by controllers, not vice versa."""
        (Rule()
         .modules_that().are_sub_modules_of("project.business_logic.service")
         .should_not()
         .import_modules_that().are_sub_modules_of("project.controller")
         .assert_applies(evaluable))

    def test_services_dont_import_orchestrators(self, evaluable):
        """Orchestrators orchestrate services, services don't import orchestrators."""
        (Rule()
         .modules_that().are_sub_modules_of("project.business_logic.service")
         .should_not()
         .import_modules_that().are_sub_modules_of("project.business_logic.orchestrator")
         .assert_applies(evaluable))

    def test_domain_is_independent(self, evaluable):
        """Domain models depend on nothing project-specific."""
        domain = Rule().modules_that().are_sub_modules_of("project.domain")
        for layer in ["business_logic", "controller", "infrastructure"]:
            (domain.should_not().import_modules_that()
             .are_sub_modules_of(f"project.{layer}")
             .assert_applies(evaluable))

    def test_infrastructure_is_leaf(self, evaluable):
        """Infrastructure is called by services, doesn't call back."""
        (Rule()
         .modules_that().are_sub_modules_of("project.infrastructure")
         .should_not()
         .import_modules_that().are_sub_modules_of("project.business_logic")
         .assert_applies(evaluable))

    def test_controllers_dont_use_infrastructure_directly(self, evaluable):
        """Controllers go through services, not directly to DB."""
        (Rule()
         .modules_that().are_sub_modules_of("project.controller")
         .should_not()
         .import_modules_that().are_sub_modules_of("project.infrastructure.database")
         .assert_applies(evaluable))
```

---

## Setup

```bash
uv add --dev pytestarch>=3.1
```

Add marker to pyproject.toml:

```toml
[tool.pytest.ini_options]
markers = [
    "architecture: Layer-dependency tests using pytestarch",
]
```

---

## Running

```bash
# Architecture tests only
uv run pytest tests/architecture/ -v

# All tests except architecture (for CI)
uv run pytest -m "not architecture"

# Architecture only (for pre-commit hook)
uv run pytest -m architecture
```

---

## Handling Known Violations

When a rule catches a legitimate import (e.g., shared key constants):

1. **First, try to fix** — extract the shared module to a neutral package
2. **If unfixable**, narrow the rule:

```python
.are_not_sub_modules_of("project.controller.shared_keys")  # explicit allow-list
```

3. **Never** delete the rule or `@pytest.mark.skip` without a `reason="..."` tracking the plan to fix.
