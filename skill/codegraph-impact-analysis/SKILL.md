---
name: codegraph-impact-analysis
description: >
  Require agents to use CodeGraphContext for dependency, caller, callee, and
  impact radius analysis before claiming a change is local.
---

# Codegraph Impact Analysis

Use this skill before non-trivial implementation and during review of multi-file changes.

## Triggers

- `codegraph-impact-analysis: {goal}` - Produce a structured impact report.
- `analyze change radius` - Inspect direct and indirect impact.
- `what else could this break` - Identify hidden coupling and risky omissions.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Target change + repository graph | Direct and indirect impact report | Short to medium |

## Process

### Phase 1: Query The Graph

Start from graph evidence, not intuition.

1. **Inspect relationships** - Query callers, callees, imports, reverse dependencies, and nearby tests.
2. **Detect graph limits** - If the repo has weak or zero graph coverage, record the limitation explicitly.

**Verification:** The report cites graph evidence or clearly states why graph evidence is missing.

### Phase 2: Produce The Impact Report

Translate findings into implementation and review guidance.

1. **Separate direct and indirect impact** - Name changed files, affected contracts, and likely breakpoints.
2. **Map verification scope** - List tests to inspect or add, plus risky omissions.

**Verification:** The report gives enough detail to shape implementation or review scope.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Calling a change local without evidence | Misses transitive impact | Use graph evidence first |
| Hiding graph coverage gaps | Creates false confidence | State limitations and fall back explicitly |

## Verification

After execution:

- [ ] Callers, callees, or dependencies were checked.
- [ ] Graph limitations are stated when present.
- [ ] Tests and contracts at risk are listed.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Query priorities, evidence rules, and fallback behavior.
