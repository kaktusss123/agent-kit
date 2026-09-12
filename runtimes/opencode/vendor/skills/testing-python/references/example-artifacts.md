# Example Testing Artifacts

## Contents

- baseline.yaml
- capsule.yaml
- plan.yaml
- sanity-report.yaml
- writer-report.yaml
- review-report.md front matter

These examples show realistic filled artifacts for one targeted run. They are illustrative, not normative.

---

```yaml
# baseline.yaml
run_id: "2026-05-06-targeted-user-service"
mode: "targeted"
test_command:
  command: "uv run pytest tests/project/services/test_user_service.py -q"
  status: "passed"
  exit_code: 0
  output_summary:
    collected: 12
    passed: 12
    failed: 0
coverage_command:
  command: "uv run pytest tests/project/services/test_user_service.py -q --cov=project/services --cov-report=json:docs/agent-testing/2026-05-06-targeted-user-service/coverage.json"
  status: "passed"
  exit_code: 0
  report_path: "docs/agent-testing/2026-05-06-targeted-user-service/coverage.json"
diff:
  base_branch: "develop"
  status: "not_applicable"
  changed_files: []
backend_strategy:
  default_backend: "in_memory"
  parity_scope: "not_requested"
  parity_commands: []
  db_specific_commands: []
  container_scope: "not_applicable"
environment_notes:
  - "Project uses pytest-cov via uv run pytest"
baseline_failures:
  explained: true
  repair_required_before_refactor: false
  items: []
global_invariants:
  requested: []
  commands: []
  results: []
regression_sets:
  exact_commands:
    - "uv run pytest tests/project/services/test_user_service.py -q"
  exact_files_or_tests:
    - "tests/project/services/test_user_service.py"
```

---

```yaml
# capsule.yaml
run_id: "2026-05-06-targeted-user-service"
capsule_id: "capsule-user-service-validation"
plan_id: "plan-user-service-validation"
title: "Cover validation and repository interaction in UserService"
mode: "targeted"
scope:
  production_files:
    - "project/services/user_service.py"
  test_files:
    - "tests/project/services/test_user_service.py"
  allowed_to_modify:
    - "tests/project/services/test_user_service.py"
    - "tests/project/services/conftest.py"
  avoid_modifying:
    - "project/services/user_service.py"
evidence:
  coverage:
    - "project/services/user_service.py: guard clauses around inactive users are uncovered"
  diff: {}
  existing_tests:
    - "tests/project/services/test_user_service.py covers create and delete flows"
initial_hints:
  likely_test_types:
    - "unit"
  likely_focus:
    - "inactive user rejection"
    - "repository update arguments"
  useful_searches:
    - "AsyncMock(spec=UserRepository)"
    - "inactive user"
constraints:
  - "Do not change production code"
global_invariants:
  requested: []
  whole_tree_commands: []
regression_sets:
  exact_files_or_tests:
    - "tests/project/services/test_user_service.py"
  exact_commands:
    - "uv run pytest tests/project/services/test_user_service.py -q"
fixture_and_factory_context:
  existing_conftest_files:
    - "tests/project/services/conftest.py"
  existing_factory_modules:
    - "tests/project/services/factories.py"
  dependency_notes:
    - "user_service fixture already returns the real service with mocked repository"
helper_placement_context:
  reusable_helpers_found:
    - "UserFactory in tests/project/services/factories.py"
  parent_conftest_coverage:
    - "tests/project/services/conftest.py provides repository mocks"
backend_context:
  pytest_option: ""
  markers: []
  in_memory_surfaces: []
  real_db_surfaces: []
  dummy_patches_to_disable: []
  cleanup_order: []
  unique_constraints: []
  qualified_field_rules: []
data_and_boundary_context:
  arbitrary_fields:
    - "email"
    - "display_name"
  semantic_literals:
    - "status=inactive"
  boundary_dimensions:
    - "inactive versus active status"
testing_standards:
  - "testing-python: invariant rules"
  - "testing-python: cheap writer safety"
expected_outputs:
  plan_file: "docs/agent-testing/2026-05-06-targeted-user-service/plans/plan-user-service-validation.yaml"
  writer_report_file: "docs/agent-testing/2026-05-06-targeted-user-service/writer-reports/plan-user-service-validation.yaml"
```

---

```yaml
# plan.yaml
run_id: "2026-05-06-targeted-user-service"
capsule_id: "capsule-user-service-validation"
plan_id: "plan-user-service-validation"
planner_summary:
  status: "ready"
  summary: "Add focused unit coverage for inactive-user rejection and repository update argument mapping."
  uncertainty: []
testing_standards:
  - "testing-python:R2"
  - "testing-python:R3"
  - "testing-python:R4"
  - "testing-python:R10"
context_examined:
  files:
    - "project/services/user_service.py"
    - "tests/project/services/test_user_service.py"
    - "tests/project/services/conftest.py"
test_targets:
  - "UserService.update_user"
behavior_gaps:
  - "Inactive users are rejected before repository update"
  - "Repository receives normalized update payload"
implementation_details:
  system_under_test:
    class: "UserService"
    methods:
      - "update_user"
  dependency_boundaries:
    - "UserRepository is mocked with AsyncMock(spec=UserRepository)"
  backend_strategy:
    mode: "in_memory_only"
    shared_test_body_required: false
    backend_selector_fixtures: []
    dormant_backend_strategy: ""
    container_scope: "not_applicable"
    cleanup_order: []
    contract_parity_notes: []
    qualified_field_rules: []
    in_memory_command: "uv run pytest tests/project/services/test_user_service.py -q"
    real_db_parity_command: ""
    real_db_specific_command: ""
    migration_command: ""
  data_construction:
    - "Build reusable user entities with UserFactory"
  fixture_placement:
    - "Reuse existing user_service and mock_user_repository fixtures"
  factory_strategy:
    - "Use UserFactory for domain objects"
  helper_placement:
    - "Keep one-off command construction local to each test"
  data_strategy:
    - "Use Faker-backed factory defaults for arbitrary fields"
  parametrization:
    - "Use parametrization for status boundary if more than one invalid status is covered"
  expected_assertions:
    - "repository.update is not awaited for inactive users"
    - "repository.update receives normalized payload for active users"
  global_invariant_checks: []
  regression_set_reruns:
    - "uv run pytest tests/project/services/test_user_service.py -q"
  stale_terminology_checks:
    - "Ensure no helper names mention old manual user builders"
implementation_order:
  - "Add inactive-user rejection test"
  - "Add repository argument mapping test"
  - "Run targeted tests"
blocked_reasons: []
verification_commands:
  - "uv run pytest tests/project/services/test_user_service.py -q"
```

---

```yaml
# sanity-report.yaml
run_id: "2026-05-06-targeted-user-service"
status: "passed"
approved_plans:
  - "plan-user-service-validation"
rejected_plans: []
overlapping_writes: []
fixture_factory_conflicts: []
oversized_scopes: []
unsupported_assumptions: []
required_repairs: []
```

---

```yaml
# writer-report.yaml
run_id: "2026-05-06-targeted-user-service"
capsule_id: "capsule-user-service-validation"
plan_id: "plan-user-service-validation"
status: "implemented"
tests_added_or_changed:
  - "tests/project/services/test_user_service.py::test_update_user_rejects_inactive_user"
  - "tests/project/services/test_user_service.py::test_update_user_passes_normalized_payload_to_repository"
files_changed:
  - "tests/project/services/test_user_service.py"
commands_run:
  - "uv run pytest tests/project/services/test_user_service.py -q"
command_results:
  - command: "uv run pytest tests/project/services/test_user_service.py -q"
    status: "passed"
    exit_code: 0
deviations: []
backend_verification:
  in_memory_commands:
    - "uv run pytest tests/project/services/test_user_service.py -q"
  real_db_commands: []
  parity_result: "not_requested"
  cleanup_strategy_checked: false
  contract_drift_findings: []
self_audit:
  standards_checked:
    - "testing-python:R2"
    - "testing-python:R3"
    - "testing-python:R4"
    - "testing-python:R10"
  findings: []
  factory_placement_findings: []
  skip_reason_findings: []
  import_placement_findings: []
  data_boundary_findings: []
  global_invariant_findings: []
  regression_set_results:
    - "uv run pytest tests/project/services/test_user_service.py -q => passed"
  stale_terminology_findings: []
remaining_problems: []
```

---

```yaml
# review-report.md front matter
run_id: "2026-05-06-targeted-user-service"
verdict: "PASS"
writer_reports_expected:
  - "docs/agent-testing/2026-05-06-targeted-user-service/writer-reports/plan-user-service-validation.yaml"
writer_reports_found:
  - "docs/agent-testing/2026-05-06-targeted-user-service/writer-reports/plan-user-service-validation.yaml"
standards_check_summary:
  invariant_rules_checked:
    - "R2"
    - "R3"
    - "R4"
    - "R10"
  focused_checks:
    bare_asyncmock: 0
    inline_imports: 0
    skip_reason_issues: 0
```
