These templates define required handoff fields. Agents may choose nested structure below these fields when it makes the artifact clearer, but they must preserve IDs, paths, status, and traceability between artifacts.

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
environment_notes: []
pre_existing_failures:
  explained: false
  items: []
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
testing_standards:
  - "python-test-guide: invariant rules"
  - "python-test-guide: cheap writer safety"
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
  data_construction: []
  expected_assertions: []
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
self_audit:
  standards_checked: []
  findings: []
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
