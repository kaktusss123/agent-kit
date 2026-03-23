# Task Workspace Domain Knowledge

## Workspace Structure

Each specification task operates in an isolated workspace:

```
specs/<task-id>/
├── spec.md                 # Implementation-ready specification
├── decision-log.md         # Append-only decision history
├── questions-log.md        # Append-only clarification history
├── repo-scout.md          # Repository reconnaissance findings
├── assumptions.md         # Unresolved temporary assumptions
└── traceability.md        # Coverage and completeness matrix
```

## Task ID Generation Rules

Priority order:
1. Existing issue/ticket key and sug (e.g., `EVODP-1234-editable-draft-lifecycle`)
2. User-provided explicit identifier
3. Stable slug from task title (e.g., `editable-draft-lifecycle`, `bulk-import-validation-rules`)

Task IDs must be:
- Concise (2-5 words)
- Human-readable
- Stable across sessions
- Filesystem-safe (no spaces, special chars)

## Log Entry Formats

### decision-log.md

```markdown
## Decision D-001

**Status**: accepted | proposed | superseded | rejected
**Date**: YYYY-MM-DD
**Decision**: Clear statement of what was decided
**Rationale**: Why this choice was made
**Alternatives considered**: What was rejected and why
**Consequences**: Downstream impact and trade-offs
**Supersedes**: D-XXX (if applicable)
```

### questions-log.md

```markdown
## Question Q-001

**Category**: scope | actors | behavior | data | validation | failure | compatibility | acceptance
**Why it matters**: Impact on implementation or user experience
**Question**: Concrete question with consequence framing
**Answer**: User's response
**Resolution status**: open | partially resolved | resolved
**Date**: YYYY-MM-DD
```

### assumptions.md

```markdown
## Assumption A-001

**Statement**: Clear assumption statement
**Reason**: Why this assumption exists
**Impact if false**: What breaks if this is wrong
**Status**: active | validated | invalidated | superseded
**Date**: YYYY-MM-DD
```

## Workspace Lifecycle

1. **Initialization**: Create workspace at first serious intake
2. **Active work**: Append to logs, never overwrite
3. **Supersession**: Mark old entries as superseded, don't delete
4. **Completion**: All artifacts remain for audit trail
5. **Archival**: Workspace persists after implementation

## Anti-Patterns

- ❌ One global decision log for all tasks
- ❌ One global question log for all tasks
- ❌ Deleting superseded decisions
- ❌ Overwriting log history
- ❌ Merging unrelated tasks into one workspace
- ❌ Using workspace as scratch space

## Integration Points

- **Kanban**: Mirror progress and blockers, but workspace files are source of truth
- **Implementation agents**: Read spec.md and decision-log.md
- **Review agents**: Check traceability.md and assumptions.md
- **QA**: Derive test cases from spec.md and traceability.md
