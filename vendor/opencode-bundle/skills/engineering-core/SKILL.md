---
name: engineering-core
description: "General engineering discipline for non-trivial software changes: understand the system, prefer the smallest coherent solution, use explicit evidence, replan on surprises, and verify changed behavior."
---

# Engineering core

Before changing non-trivial behavior, understand the current path well enough to know where state, contracts, side effects, and tests live.

Prefer the smallest coherent solution that satisfies the request. Do not widen a task into opportunistic cleanup unless the wider change is required for correctness.

Treat plans as hypotheses. When repository reality contradicts an assumption, stop following the stale plan and update the approach from the new evidence.

Use fast feedback during implementation. Inspect the diff before handoff. Verify behavior through checks that can actually observe the requirement.

Escalate only when the missing decision belongs to the user or governing spec. Resolve ordinary repository facts yourself.
