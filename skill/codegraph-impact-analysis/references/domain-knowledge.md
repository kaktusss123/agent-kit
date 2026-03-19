# Codegraph Impact Analysis Knowledge

## Preferred Queries

- Callers and reverse dependencies
- Callees and forward dependencies
- Import edges and entrypoints
- Nearby tests and transitive impact zones

## Evidence Rule

- Never call a change local unless graph or file evidence supports it.
- If graph coverage is absent or weak, say so explicitly before falling back.

## Output Shape

- Direct impact
- Indirect impact
- Contracts or APIs at risk
- Tests to inspect or add
- Unknowns and hotspots
