---
name: complexity-review
description: "Reference playbook and report template for manual algorithmic complexity review. Phase one: no scanner execution."
---

# Complexity Review

This skill provides reference material for manual algorithmic complexity review in the Dev2 suite.

## Scope

Phase one: `dev2-reviewer-complexity` performs manual read-only complexity analysis using the references in this skill. No automated scanner execution.

## Triggers

| Trigger | Description |
|---------|-------------|
| Nested loops or repeated scans | Code contains O(n^2) or worse patterns |
| Membership/search inside loops | Linear search inside iteration |
| Sorting inside loops | Repeated sorting in hot paths |
| N+1 query/API patterns | Database or API calls inside iteration |
| Recomputed derived data | Derived values recalculated in render paths |
| Pairwise/range/grouping logic | Interval, range, or grouping algorithm changes |
| Explicit optimization request | User asks for complexity review |

## Quick Reference

### Complexity Classes

| Class | Typical Pattern | When to Flag |
|-------|----------------|--------------|
| O(1) | Direct lookup, hash map access | Never |
| O(log n) | Binary search, tree traversal | Rarely |
| O(n) | Single pass, linear scan | Only in known hot paths |
| O(n log n) | Sorting, balanced tree ops | When data size is large |
| O(n^2) | Nested loops, pairwise comparisons | Always in production code |
| O(2^n) | Recursive enumeration, brute force | Critical blocker |

### Optimization Patterns

1. **Hash map lookup**: Replace linear search with dictionary/set membership.
2. **Pre-computation**: Cache derived values instead of recomputing.
3. **Batching**: Group N+1 calls into a single batch query.
4. **Incremental update**: Maintain running aggregates instead of full recomputation.
5. **Early exit**: Short-circuit when result is determined.
6. **Index utilization**: Use sorted structures for range queries.

## Review Checklist

1. Identify the data size (n) for each changed hotspot.
2. Estimate current complexity class.
3. Estimate complexity after the change.
4. Determine if the hot path justifies optimization.
5. Check for duplicate/order/key-normalization semantic preservation.
6. Verify cache invalidation and mutability assumptions.
7. Confirm auth/filter/pagination preservation for batching changes.
8. List tests or benchmarks needed to validate the optimization.

## Resources

- `references/optimization-playbook.md`: Detailed optimization patterns and trade-offs.
- `references/report-template.md`: Structured output template for complexity review findings.

## Non-Goals

- Phase one does NOT execute `scripts/analyze_complexity.py`.
- Scanner output (if enabled later) is treated as leads, not proof.
- This skill does not replace domain-specific performance review.
