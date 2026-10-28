---
name: diagnosing-bugs
description: "Evidence-first diagnosis for hard bugs, regressions, flaky failures, performance problems, and live operational failures. Use when: something is broken, failing, intermittently wrong, or unexpectedly slow; connectivity, routing, DNS, tunnel, deploy, or runtime-config trouble misbehaves with no obvious cause; you need a tight reproduction loop, ranked falsifiable hypotheses, focused instrumentation, a root-cause fix, and regression proof rather than theory-first patching. Not for: reading how a subsystem is designed; use skill://system-understanding."
---

# Diagnosing bugs

The first deliverable is a feedback loop that can catch the reported bug.

## Build a red-capable loop

Prefer, in order of fit:
- failing test at the real seam;
- CLI/API reproduction script;
- trace replay;
- minimal throwaway harness;
- differential old/new comparison;
- repeated stress loop for flaky behavior;
- profiler or timing harness for performance.

Tighten it until it is as fast, deterministic, and specific to the reported symptom as practical. Do not mistake a nearby failure for the user's bug.

## Minimize

Reduce the reproduction one element at a time while keeping it red. The remaining inputs, state, callers, timing, and configuration define the useful hypothesis space.

## Hypothesize before patching

Generate several ranked, falsifiable hypotheses. For each, state what observation would make it more or less likely.

Instrument only where it discriminates between hypotheses. Prefer debugger/inspection or targeted measurements over "log everything".

## Fix the cause

Turn the minimal repro into a regression test when a correct seam exists. Apply the smallest root-cause fix. Then run both the regression test and the original unminimized reproduction.

For performance, measure before and after with the same harness.

## Cleanup

Remove temporary instrumentation and throwaway artifacts unless they are intentionally kept as a useful regression tool. State the root cause and the evidence that distinguishes it from the rejected hypotheses.
