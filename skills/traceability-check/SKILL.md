---
name: traceability-check
description: "Verifies completeness and traceability of specifications by linking goals, scenarios, requirements, edge cases, tests, and acceptance criteria."
---

# Traceability Check

Verify completeness and traceability of specifications to ensure they are ready for implementation and testing.

## Triggers

| Trigger | Description |
|---------|-------------|
| Before declaring spec_ready | Final completeness gate |
| After spec written but before review | Verify coverage before human review |
| After spec updates | Ensure changes didn't break traceability |
| During spec review | Identify gaps and contradictions |
| Before handoff to implementation | Implementation readiness check |

## Quick Reference

| Phase | Action | Output |
|-------|--------|--------|
| 1 | Build traceability matrix | Requirements linked to goals, scenarios, tests, AC |
| 2 | Run verification checklist | Gap list by category |
| 3 | Detect contradictions | Conflicting statements across sections |
| 4 | Detect ambiguities | Vague language patterns |
| 5 | Assess completeness | Completeness heuristics |
| 6 | Produce report | Coverage metrics, gaps, contradictions, readiness |

## What to Check

| # | Check | Description |
|---|-------|-------------|
| 1 | Goal mapping | Each goal maps to one or more functional requirements |
| 2 | Scenario coverage | Each important scenario has defined expected behavior |
| 3 | Edge case coverage | Each major edge case has expected behavior and test implications |
| 4 | Contract coverage | Each affected contract has a compatibility treatment |
| 5 | Requirement testing | Each important requirement has testing strategy reference |
| 6 | AC traceability | Each acceptance criterion maps to concrete requirements |
| 7 | Honest unknowns | Open questions are not disguised as settled facts |
| 8 | No contradictions | Sections do not contradict each other |

## Traceability Matrix Structure

| Requirement ID | Goal(s) | Scenario(s) | Test Type(s) | Acceptance Criteria | Status | Notes |
|----------------|---------|-------------|--------------|---------------------|--------|-------|
| FR-1 | G-1, G-2 | S-1, S-3 | Unit, Integration | AC-1, AC-2 | ✅ Complete | - |
| FR-2 | G-1 | S-2 | E2E | AC-3 | ⚠️ Partial | Missing integration test |
| BR-1 | G-2 | S-4 | Unit | AC-4 | ❌ Missing | No test coverage |

### Coverage Categories

| Status | Meaning |
|--------|---------|
| ✅ Complete | Fully traced and tested |
| ⚠️ Partial | Traced but incomplete coverage |
| ❌ Missing | No traceability or coverage |
| 🔄 In Progress | Being addressed |

## Verification Checklist

### 1. Goal Coverage

For each goal in the spec:
- [ ] At least one functional requirement maps to this goal
- [ ] The requirement(s) are sufficient to achieve the goal
- [ ] No goals are orphaned (no requirements)

### 2. Scenario Coverage

For each important scenario:
- [ ] Expected behavior is explicitly defined
- [ ] Edge cases are covered
- [ ] Failure paths are specified
- [ ] Recovery paths are documented

### 3. Requirement Coverage

For each functional requirement:
- [ ] Maps back to at least one goal
- [ ] Appears in at least one scenario
- [ ] Has test strategy reference
- [ ] Has acceptance criteria reference

### 4. Edge Case Coverage

For each identified edge case:
- [ ] Expected behavior is defined
- [ ] Test implications are noted
- [ ] Logging/metrics implications are specified

### 5. Contract Coverage

For each affected contract:
- [ ] Compatibility impact is assessed
- [ ] Migration strategy is defined (if needed)
- [ ] Testing approach is specified

### 6. Acceptance Criteria Coverage

For each acceptance criterion:
- [ ] Maps to concrete requirements or behaviors
- [ ] Is verifiable/testable
- [ ] Success condition is clear

## Gap Analysis

### Common Gaps

| # | Gap | Severity |
|---|-----|----------|
| 1 | Orphaned requirements (not linked to any goal) | High |
| 2 | Untested requirements (no test strategy) | High |
| 3 | Vague acceptance criteria (not verifiable) | Medium |
| 4 | Missing edge cases (important scenarios not covered) | High |
| 5 | Incomplete failure handling (error paths not specified) | Critical |
| 6 | Missing observability (no logs/metrics for critical ops) | Medium |
| 7 | Unaddressed compatibility (breaking changes without migration) | Critical |

### Gap Severity Scale

| Severity | Meaning |
|----------|---------|
| Critical | Blocks implementation or causes production risk |
| High | Significant ambiguity or missing coverage |
| Medium | Minor gaps that should be addressed |
| Low | Nice-to-have improvements |

## Contradiction Detection

### Common Contradiction Types

| Type | Description |
|------|-------------|
| Scope contradictions | In-scope vs out-of-scope conflicts |
| Behavior contradictions | Different sections describe different behavior |
| Data contradictions | Schema vs validation rules mismatch |
| Permission contradictions | Different sections specify different access rules |
| Assumption contradictions | Assumptions conflict with decisions |

## Ambiguity Detection

### Vague Language Patterns

| Phrase | Problem | Fix |
|--------|---------|-----|
| "should work smoothly" | Not specific | Define concrete behavior |
| "handle errors properly" | Not specific | Define error handling per case |
| "support all cases" | Not bounded | List supported cases |
| "reasonable performance" | Not measurable | Define quantitative targets |
| "good user experience" | Not testable | Define concrete UX criteria |
| "as needed" | Not bounded | Define conditions explicitly |
| "when appropriate" | Not bounded | Define explicit conditions |

Replace with: specific behaviors, quantitative targets, concrete examples, or explicit conditions.

## Completeness Heuristics

| Test | Question |
|------|----------|
| Developer test | Can a developer implement this without guessing? |
| QA test | Can QA derive a test plan directly from this? |
| Reviewer test | Can a reviewer tell what's intentionally out of scope? |
| Operator test | Are rollout, rollback, and observability clear? |
| User test | Is user-visible behavior fully specified? |

## Output Artifact

Write findings to `docs/specs/<task-id>/traceability.md`:

```markdown
# Traceability Report

## Coverage Summary
- Goals: X/Y covered (Z%)
- Functional Requirements: X/Y tested (Z%)
- Business Rules: X/Y tested (Z%)
- Validation Rules: X/Y tested (Z%)
- Edge Cases: X/Y specified (Z%)
- Acceptance Criteria: X/Y traceable (Z%)

## Coverage Matrix
[Detailed matrix here]

## Gaps
### Critical Gaps
- [Gap description with impact]

### High Priority Gaps
- [Gap description with impact]

## Contradictions
### Contradiction 1: [Title]
- **Location 1**: [Section] says [X]
- **Location 2**: [Section] says [Y]
- **Impact**: [What this affects]
- **Recommendation**: [How to resolve]

## Ambiguities
### Ambiguity 1: [Title]
- **Location**: [Section]
- **Vague statement**: "[Quote]"
- **Impact**: [What's unclear]
- **Recommendation**: [Specific replacement]

## Recommended Fixes
1. [Priority] [Action item]
2. [Priority] [Action item]

## Readiness Assessment
- [ ] All critical gaps resolved
- [ ] All contradictions resolved
- [ ] All blocking ambiguities resolved
- [ ] Minimum coverage thresholds met

**Status**: ✅ Ready | ⚠️ Needs work | ❌ Not ready
```

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | If there are blocking coverage gaps, do not treat the spec as ready |
| 2 | If a requirement cannot be traced to tests or acceptance criteria, flag it |
| 3 | If two sections conflict, do not average them; surface the contradiction explicitly |
| 4 | A traceability pass is not optional for an implementation-ready spec |

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Averaging contradictions | Hides real conflict | Surface contradiction explicitly |
| Accepting vague language | Spec not implementable | Replace with specific, testable statements |
| Skipping coverage matrix | No systematic traceability | Build full matrix with all categories |
| Only checking happy path | Misses failure coverage | Check all paths |
| Ignoring severity in gaps | Treats all gaps equally | Classify by critical/high/medium/low |
| Declaring ready without traceability pass | Incomplete spec | Traceability is mandatory |

## Verification Checklist

- [ ] Traceability matrix built with all requirements linked
- [ ] Goal coverage: each goal has at least one requirement
- [ ] Scenario coverage: each scenario has expected behavior
- [ ] Edge case coverage: each edge case has behavior, test, logging defined
- [ ] Contract coverage: each contract assessed for compatibility
- [ ] Acceptance criteria: each AC maps to concrete requirements
- [ ] No contradictions between sections
- [ ] No vague language in spec
- [ ] Gap analysis with severity classification done
- [ ] Completeness heuristics passed (5 tests)
- [ ] Readiness status determined (Ready / Needs work / Not ready)
- [ ] `traceability.md` written to workspace
