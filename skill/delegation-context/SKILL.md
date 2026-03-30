---
name: delegation-context
description: Enforces complete context passing when orchestrators delegate to subagents.
---

# Delegation Context

**MANDATORY FOR ORCHESTRATORS** - Pass COMPLETE context in initial delegation prompt.

## The Problem

Orchestrators delegate with incomplete context:
- ❌ "скоуп задачи тот же самый" (без контекста)
- ❌ "do the same as above" (нет "above" у субагента)
- ❌ "templates/01..13" (ambiguous range)
- ❌ "the config", "main file" (undefined terms)

**Result:** Субагенты тратят время на выяснение контекста или делают wrong assumptions.

## Triggers

- **Mandatory import** для orchestrator agents
- `task(...)` - BEFORE any delegation, apply these rules
- `delegation-context: check` - Validate prompt before sending

## Core Rules (NON-NEGOTIABLE)

### Rule 1: Context Location

Context stored in **ANY** of:
1. **Kanban item** - Link to kanban #{id} with full description/decisions
2. **docs/** - File at `docs/*.md`
3. **Inline** - Full context in delegation prompt (for simple tasks)

### Rule 2: Delegation Contract

Every `task(...)` MUST include all 5 sections:

```javascript
task(
  subagent_type="...",
  description="One-liner",
  prompt=`
## 1. Objective
{ONE sentence - no ambiguity}

## 2. Context
{Choose only those that contain context:
  - Kanban: #{id} - {title} - {link}
  - File: docs/context/{task}.md
  - Inline: Full context below}

## 3. Evidence
{Files with path:line, quotes, kanban references}

## 4. Expected Output
{Exact shape: files, structure, or answer format}

## 5. Constraints
{Explicit boundaries - what NOT to do}

## 6. Validation
{Self-verification checklist before reporting complete}
`
)
```

### Rule 3: Explicit Scope

| Scope Type | Required Format | Example |
|------------|----------------|---------|
| Files | Explicit list OR rooted glob | `[f1, f2, f3]` OR `src/**/*.py` |
| Commit | Full hash | `abc123def456...` |
| Diff | Base + HEAD | `origin/develop...HEAD` |

**NEVER:** `templates/01..13`, `files 1-10`, `the rest`

### Rule 4: No Implicit References

| Forbidden | Replacement |
|-----------|-------------|
| "same as above" | "Same as {file:line}: {quote}" |
| "as discussed" | "Per kanban #{id}: {quote decision}" |
| "templates/01..13" | List all 13 files OR `templates/{01..13}_*.py` |
| "the config" | `configs/database.yaml` |
| "don't break anything" | "Do NOT modify: {explicit paths}" |
| "usual approach" | "Pattern from {file:line}: {describe}" |

## Process

### Before Delegation

1. **Choose context location:**
   - Complex task → Create `docs/context/{task-slug}.md` OR kanban item
   - Simple task → Inline context in prompt

2. **Gather context:**
   - All files read (with path:line)
   - Decisions made (with rationale)
   - Constraints (with severity)
   - Success criteria (measurable)

3. **Build prompt** with all 5 contract sections

4. **Validate:**
   - [ ] All 5 sections present
   - [ ] No implicit references
   - [ ] Scope is explicit
   - [ ] Context location specified

## Related Skills

| Skill | Relationship |
|-------|--------------|
| `workflow-gates` | Complements gates |
| `task-workspace` | Alternative context storage |
| `decision-log` | Decisions reference |

---

**ENFORCEMENT:** Delegations violating these rules MUST be rejected.
