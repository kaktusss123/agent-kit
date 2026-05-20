# Codegraph Impact Analysis Knowledge

## Preferred Queries

- Callers and reverse dependencies
- Callees and forward dependencies
- Import edges and entrypoints
- Nearby tests and transitive impact zones

## Evidence Rule

- Never call a change local unless file-level evidence (read/glob/grep) supports it.
- If certain areas cannot be verified through available files, say so explicitly before proceeding.

## Output Shape

- Direct impact
- Indirect impact
- Contracts or APIs at risk
- Tests to inspect or add
- Unknowns and hotspots
