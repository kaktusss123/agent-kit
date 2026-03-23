# Traceability Check Domain Knowledge

## Traceability Principles

A traceable specification ensures:
1. Every goal maps to concrete requirements
2. Every requirement maps to test coverage
3. Every acceptance criterion maps to verifiable behavior
4. No orphaned requirements or untested behaviors
5. No contradictions between sections

## Traceability Matrix Structure

### Minimum Required Mappings

| Requirement ID | Goal(s) | Scenario(s) | Test Type(s) | Acceptance Criteria | Status | Notes |
|----------------|---------|-------------|--------------|---------------------|--------|-------|
| FR-1 | G-1, G-2 | S-1, S-3 | Unit, Integration | AC-1, AC-2 | ✅ Complete | - |
| FR-2 | G-1 | S-2 | E2E | AC-3 | ⚠️ Partial | Missing integration test |
| BR-1 | G-2 | S-4 | Unit | AC-4 | ❌ Missing | No test coverage |

### Coverage Categories

- **✅ Complete**: Fully traced and tested
- **⚠️ Partial**: Traced but incomplete coverage
- **❌ Missing**: No traceability or coverage
- **🔄 In Progress**: Being addressed

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

1. **Orphaned requirements**: Requirements not linked to any goal
2. **Untested requirements**: Requirements without test strategy
3. **Vague acceptance criteria**: AC that can't be objectively verified
4. **Missing edge cases**: Important scenarios not covered
5. **Incomplete failure handling**: Error paths not specified
6. **Missing observability**: No logs/metrics for critical operations
7. **Unaddressed compatibility**: Breaking changes without migration plan

### Gap Severity

- **Critical**: Blocks implementation or causes production risk
- **High**: Significant ambiguity or missing coverage
- **Medium**: Minor gaps that should be addressed
- **Low**: Nice-to-have improvements

## Contradiction Detection

### Common Contradiction Types

1. **Scope contradictions**: In-scope vs out-of-scope conflicts
2. **Behavior contradictions**: Different sections describe different behavior
3. **Data contradictions**: Schema vs validation rules mismatch
4. **Permission contradictions**: Different sections specify different access rules
5. **Assumption contradictions**: Assumptions conflict with decisions

### Resolution Process

When contradiction found:
1. Document both conflicting statements
2. Identify which is correct (or if both are wrong)
3. Update spec to resolve contradiction
4. Record resolution in decision-log.md
5. Mark old statement as superseded if applicable

## Ambiguity Detection

### Vague Language Patterns

- "should work smoothly"
- "handle errors properly"
- "support all cases"
- "reasonable performance"
- "good user experience"
- "as needed"
- "when appropriate"

### Resolution

Replace vague statements with:
- Specific behaviors
- Quantitative targets
- Concrete examples
- Explicit conditions

## Completeness Heuristics

Ask these questions:

1. **Developer test**: Can a developer implement this without guessing?
2. **QA test**: Can QA derive a test plan directly from this?
3. **Reviewer test**: Can a reviewer tell what's intentionally out of scope?
4. **Operator test**: Are rollout, rollback, and observability clear?
5. **User test**: Is user-visible behavior fully specified?

## Traceability Report Format

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

### Medium Priority Gaps
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

## Anti-Patterns

- ❌ Treating traceability check as optional
- ❌ Ignoring gaps because "it's obvious"
- ❌ Averaging contradictions instead of resolving them
- ❌ Marking spec ready with critical gaps
- ❌ Not updating spec after finding issues
- ❌ Treating traceability as a one-time check (should be continuous)
