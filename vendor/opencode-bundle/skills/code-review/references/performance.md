# Performance lens

Inspect only paths where cost matters.

Look for added network or disk round trips, N+1 work, unbounded loops, repeated parsing or allocation, lock contention, accidental serialization, cache invalidation mistakes, and behavior whose cost grows unexpectedly with input size.

Prefer evidence from the actual hot path over generic optimization advice.
