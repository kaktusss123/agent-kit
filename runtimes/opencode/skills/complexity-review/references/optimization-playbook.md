# Complexity Optimization Playbook

## 1. Common Complexity Patterns

### 1.1 Nested Loops (O(n^2) or worse)

**Pattern**: Iterating over a collection while iterating over the same or another collection inside.

**Detection**:
- `for x in items: for y in items:` 
- Database queries inside a loop
- API calls inside a loop

**Optimization**:
- Use hash maps for O(1) lookups
- Pre-index data by key
- Batch queries outside the loop
- Use set intersection for membership checks

### 1.2 Repeated Scans (O(k * n))

**Pattern**: Scanning the same data structure multiple times for different predicates.

**Detection**:
- Multiple `filter()`, `map()`, or list comprehensions over the same source
- Repeated `find()` or `search()` calls

**Optimization**:
- Single-pass accumulation with multiple outputs
- Build lookup structures in one pass
- Use generators for lazy evaluation when memory allows

### 1.3 N+1 Query Pattern

**Pattern**: One query to get a list, then N queries to get related data for each item.

**Detection**:
- ORM `.get()` or `.filter()` inside a loop
- HTTP requests inside iteration

**Optimization**:
- Use `JOIN` or `IN` clause for batch retrieval
- DataLoader pattern for deferred batch loading
- Prefetch related entities in the initial query

### 1.4 Sorting Inside Loops

**Pattern**: Sorting a collection on every iteration.

**Detection**:
- `sorted()` or `.sort()` inside a loop body
- Repeated heap operations

**Optimization**:
- Sort once before the loop
- Use insertion into a sorted structure
- Maintain a heap incrementally

### 1.5 Recomputed Derived Data

**Pattern**: Recalculating the same derived value multiple times.

**Detection**:
- Repeated aggregation (sum, count, groupby) over the same source
- Template rendering with expensive computations

**Optimization**:
- Memoize or cache derived values
- Use incremental updates (delta application)
- Pre-compute at write time instead of read time

## 2. Trade-Off Considerations

### 2.1 Space vs Time

Optimization often trades memory for speed. Consider:
- Data size vs available memory
- Cache locality and CPU cache effects
- GC pressure from temporary structures

### 2.2 Readability vs Performance

- Document non-obvious optimizations
- Keep the simple version as a comment when possible
- Benchmark before and after to justify complexity

### 2.3 Correctness Preservation

Optimization must NOT change:
- Observable semantics
- Auth/filter/pagination behavior
- Error handling paths
- Edge case behavior (empty, single element, duplicates)

## 3. When NOT to Optimize

- Data size is bounded and small (n < 100)
- Code is not in a hot path
- Optimization makes code significantly harder to maintain
- No measurable performance impact exists
- The current complexity is acceptable for the use case
