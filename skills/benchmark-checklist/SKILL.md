---
name: benchmark-checklist
description: "Design or assess a meaningful performance comparison. Use when: benchmarking, investigating a slowdown, or reviewing a performance claim where workload, correctness, timing boundaries, and measurement variation matter."
---

# Benchmark checklist

- Define the user-relevant operation, dataset, scale, success criteria, metric and timing boundaries. Complete all useful work belonging to that declared operation, including awaiting its asynchronous completion, before stopping the clock; prevent eliminated or cached-away work from masquerading as speed. Validate the results and count errors of the actual measured invocations for every candidate; a separate preflight correctness check is not a substitute. Include validation and error accounting in the timed region only when they are part of the defined metric. Otherwise keep them outside the clock, do not let them change the operation being measured, and disclose external measurement overhead.
- Compare equivalent behavior and inputs with comparable configuration, tuning, environment and resource limits. Disclose differences, warmup, caching and concurrency; do not present incomparable runs as a speedup.
- Repeat and, where feasible, interleave baseline and candidate observations to expose drift. Report individual observations or a useful distribution and variation, not just the best run or unsupported precision. Choose repetitions for the noise and cost; no fixed count guarantees confidence.
- Measure the real user path when practical, or state exactly what the microbenchmark omits. Separate profiling and instrumentation runs from reported timings because they can perturb results.
- Record commands, revisions, environment, workload, correctness/error counts and timing boundaries so another person can reproduce the comparison. If noise, errors or insufficient observations prevent a conclusion, say `inconclusive` and explain what is missing.

Benchmarking does not authorize production load, writes or external side effects; obtain the appropriate authority and isolate data. Return the evidence and conclusion, not a performance claim unsupported by measurements.

Adapted from ideas in [pstack benchmark-checklist](https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/benchmark-checklist), Lauren Tan, 2026.
