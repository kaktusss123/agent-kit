---
name: blast-radius
description: "Find non-obvious downstream breakage a code or contract change could cause and prove the key safety assumptions with real evidence. Use for risky, cross-cutting, integration, compatibility, lifecycle, persistence, concurrency, or small-but-suspicious changes where grep of direct callers is not enough."
---

# Blast radius

Caller lists are reconnaissance. The job is to identify the few facts the change's safety actually depends on.

## Trace beyond the diff

Inspect relevant:
- callers and downstream consumers;
- serialized/wire/database formats;
- external libraries at the pinned version;
- lifecycle and ordering assumptions;
- retries, idempotency, cleanup, and recovery;
- other languages/services reading the same contract;
- migration and compatibility paths.

Do not invent risk without a plausible mechanism.

## Prove the safety facts

For each material risk, state the fact that would make it safe or unsafe. Get that fact as far as cheaply possible from:
1. source or contract evidence;
2. traced impossibility/possibility of the bad path;
3. focused executable script or test;
4. real running integration when required.

Mark unproven assumptions as unproven.

## Output

Return:
- what changed semantically;
- key safety facts and proof level;
- confirmed risks with likelihood/impact in practical terms;
- important risks checked and cleared;
- cheapest check to run before acceptance.
