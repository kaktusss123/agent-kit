# Completeness

Ask whether an implementer can execute the spec without silently inventing important behavior.

Check only relevant dimensions: normal behavior, failure paths, boundaries, lifecycle or state transitions, data consequences, compatibility or migration, external dependencies, and explicit non-goals.

Treat a missing item as blocking only when it changes observable behavior, architecture, compatibility, rollout, risk, or scope. Do not manufacture speculative edge cases to make the review look thorough.
