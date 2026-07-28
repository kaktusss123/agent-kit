# Complexity Review Report Template

## REVIEW COMPLETE

reviewer: reviewer-complexity
domain: complexity
review_tier: R<N>
scope_commit: <hash>
verdict: PASS | PASS_WITH_NOTES | FAIL

### Hotspots Analyzed

| # | File:line | Pattern | Current O() | Proposed O() | Data Size (n) | Hot Path? |
|---|-----------|---------|-------------|--------------|---------------|-----------|

### Findings

| id | severity | location | finding | evidence | remediation |
|---|---|---|---|---|---|

### Coverage

- Hotspots reviewed:
- Hotspots not reviewed (reason):
- Residual risk:

### Recommendations

- Tests/benchmarks needed:
- Optimization candidates:
- Deferred items:

### Escalation

- needs_human: yes/no
- suggested_next_gate: pass | revision | escalation | abort

---

## REVIEW BLOCKED

reviewer: reviewer-complexity
reason: <missing context/evidence>
missing_inputs:
  - <field>
recommended_next_gate: escalation | abort
