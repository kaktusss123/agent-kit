---
name: kanban-discipline
description: >
  Make kanban the durable record for scope, status, decisions, blockers,
  verification, and review outcomes. Includes fallback strategy when kanban MCP is unavailable.
---

# Kanban Discipline

Use this skill whenever task state must be recorded outside the model context.

Any agent or skill that loads this skill receives a complete, self-contained kanban interaction contract: availability check, primary path, and fallback path.

## Availability Check

**Before any kanban operation**, verify that kanban MCP tools are available:

1. Attempt to call a kanban tool (e.g., `kanban_list_items`)
2. If successful: proceed with kanban operations
3. If failed with "tool not available" or similar:
   - Skip all kanban API calls
   - Fall back to file-based logging in `decision-log.md`
   - Optionally notify user: "Kanban MCP not available, using file-based logging"

**No other file or agent should duplicate this check.** This skill is the single source of truth for kanban availability handling.

## Triggers

- `kanban-discipline: {goal}` — Update the task record correctly.
- `log this decision in kanban` — Persist a decision or blocker.
- `move this task to the next stage` — Advance workflow state with evidence.

## Quick Reference

| Input | Output | Duration |
|-------|--------|----------|
| Task stage + evidence | Updated kanban item and notes (or file-based fallback) | Short |

## Process

### Phase 1: Ensure The Record Exists

Find the task or create it before deeper work continues.

1. **Create or locate item** — Use a feature, issue, or todo item that matches the request.
2. **Populate core fields** — Record objective, scope and non-goals, acceptance criteria, current stage, next step, decisions and blockers, and verification and review outcome.

**Verification:** The task can be found again without relying on chat history.

### Phase 2: Keep State Current

Update kanban at every meaningful stage transition.

1. **Record decisions and blockers** — Persist rationale, rejected alternatives, and surprises.
2. **Write stage summaries** — Log verification results, review outcome, and residual risk before Done.

**Verification:** Another agent can resume the task from kanban (or file-based logs) alone.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Leaving decisions only in chat | Process memory gets lost | Log decisions in kanban (if available) or `decision-log.md` |
| Marking tasks done without evidence | Hides incomplete work | Require verification and review summaries |
| Failing when kanban unavailable | Breaks workflow | Degrade gracefully to file-based logging |
| Duplicating availability checks in agents | Creates inconsistent behavior | Load this skill — it handles availability uniformly |

## Verification

After execution:

**If kanban MCP available:**
- [ ] The task exists in kanban
- [ ] Current stage and next step are recorded
- [ ] Decisions, blockers, or verification notes are persisted

**If kanban MCP NOT available:**
- [ ] Decisions logged to `decision-log.md`
- [ ] Questions logged to `questions-log.md`
- [ ] File-based tracking is sufficient for task resumption

