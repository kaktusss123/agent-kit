---
name: codegraph-impact-analysis
description: >
  Require agents to use repository inspection (read/glob/grep) for dependency, caller, callee, and
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
| Target change + repository files | Direct and indirect impact report | Short to medium |

## Process

### Phase 1: Inspect Repository Evidence

Start from file-level evidence, not intuition.

1. **Inspect relationships** - Use read/glob/grep to find callers, callees, imports, reverse dependencies, and nearby tests.
2. **Detect coverage limits** - If certain areas lack test or documentation coverage, record the limitation explicitly.

**Verification:** The report cites file-level evidence or clearly states where evidence is missing.

### Phase 2: Produce The Impact Report

Translate findings into implementation and review guidance.

1. **Separate direct and indirect impact** - Name changed files, affected contracts, and likely breakpoints.
2. **Map verification scope** - List tests to inspect or add, plus risky omissions.

**Verification:** The report gives enough detail to shape implementation or review scope.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Calling a change local without evidence | Misses transitive impact | Use repository inspection first |
| Hiding coverage gaps | Creates false confidence | State limitations and note what could not be verified |

## Verification

After execution:

- [ ] Callers, callees, or dependencies were checked via read/glob/grep.
- [ ] Evidence gaps are stated when present.
- [ ] Tests and contracts at risk are listed.

## References

- [`references/domain-knowledge.md`](references/domain-knowledge.md) - Query priorities and evidence rules.
