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
context_examined:
  production_files: []
  test_files: []
  fixtures: []
  searched_callers: []
  searched_callees: []
targets: []
implementation_order: []
blocked_reasons: []
```