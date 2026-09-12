# Testing Artifact Templates

## Contents

- Purpose
- baseline.yaml
- capsule.yaml
- plan.yaml
- sanity-report.yaml
- writer-report.yaml
- review-report.md front matter

## Purpose

These templates define required handoff fields. Agents may choose nested structure below these fields when it makes the artifact clearer, but they must preserve IDs, paths, status, and traceability between artifacts.

Baseline failures are recorded before editing. They are not a post-hoc excuse for regressions introduced during implementation.

For filled examples, see [example-artifacts.md](example-artifacts.md).

```yaml
# baseline.yaml
run_id: ""
mode: ""
test_command:
  command: ""
  status: "passed | failed | not_run"
  exit_code: null
  output_summary: {}
coverage_command:
  command: ""
  status: "passed | failed | not_run"
  exit_code: null
  report_path: ""
diff:
  base_branch: "develop"
  status: "available | unavailable | not_applicable"
  changed_files: []
backend_strategy:
  default_backend: "in_memory | project_default | unknown"
  parity_scope: "not_requested | requested | not_applicable"
  parity_commands: []
  db_specific_commands: []
  container_scope: "function | module | session | unknown"
environment_notes: []
baseline_failures:
  explained: false
  repair_required_before_refactor: false
  items: []
global_invariants:
  requested: []
  commands: []
  results: []
regression_sets:
  exact_commands: []
  exact_files_or_tests: []
```
---

```yaml
# capsule.yaml
run_id: ""
capsule_id: ""
plan_id: ""
title: ""
mode: ""
scope:
  production_files: []
  test_files: []
  allowed_to_modify: []
  avoid_modifying: []
evidence:
  coverage: []
  diff: {}
  existing_tests: []
initial_hints:
  likely_test_types: []
  likely_focus: []
  useful_searches: []
constraints: []
global_invariants:
  requested: []
  whole_tree_commands: []
regression_sets:
  exact_files_or_tests: []
  exact_commands: []
fixture_and_factory_context:
  existing_conftest_files: []
  existing_factory_modules: []
  dependency_notes: []
helper_placement_context:
  reusable_helpers_found: []
  parent_conftest_coverage: []
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
  arbitrary_fields: []
  semantic_literals: []
  boundary_dimensions: []
testing_standards:
  - "testing-python: invariant rules"
  - "testing-python: cheap writer safety"
expected_outputs:
  plan_file: ""
  writer_report_file: ""
```
---

```yaml
# plan.yaml
run_id: ""
capsule_id: ""
plan_id: ""
planner_summary:
  status: "ready | blocked | partial"
  summary: ""
  uncertainty: []
testing_standards: []
context_examined: {}
test_targets: []
implementation_details:
  system_under_test: {}
  dependency_boundaries: []
  backend_strategy:
    mode: "in_memory_only | dual_backend | real_db_only"
    shared_test_body_required: false
    backend_selector_fixtures: []
    dormant_backend_strategy: ""
    container_scope: ""
    cleanup_order: []
    contract_parity_notes: []
    qualified_field_rules: []
    in_memory_command: ""
    real_db_parity_command: ""
    real_db_specific_command: ""
    migration_command: ""
  data_construction: []
  fixture_placement: []
  factory_strategy: []
  helper_placement: []
  data_strategy: []
  parametrization: []
  expected_assertions: []
  global_invariant_checks: []
  regression_set_reruns: []
  stale_terminology_checks: []
implementation_order: []
blocked_reasons: []
verification_commands: []
```
---

```yaml
# sanity-report.yaml
run_id: ""
status: "passed | failed"
approved_plans: []
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
run_id: ""
capsule_id: ""
plan_id: ""
status: "implemented | partial | blocked"
tests_added_or_changed: []
files_changed: []
commands_run: []
command_results: []
deviations: []
backend_verification:
  in_memory_commands: []
  real_db_commands: []
  parity_result: "not_requested | passed | failed | blocked"
  cleanup_strategy_checked: false
  contract_drift_findings: []
self_audit:
  standards_checked: []
  findings: []
  factory_placement_findings: []
  skip_reason_findings: []
  import_placement_findings: []
  data_boundary_findings: []
  global_invariant_findings: []
  regression_set_results: []
  stale_terminology_findings: []
remaining_problems: []
```
---

```yaml
# review-report.md front matter
run_id: ""
verdict: "PASS | PASS_WITH_NOTES | FAIL"
writer_reports_expected: []
writer_reports_found: []
standards_check_summary: {}
```
