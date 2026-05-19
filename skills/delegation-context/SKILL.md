---
name: delegation-context
description: "Governs how orchestrator agents delegate to specialized subagents: context passing rules, handoff expectations, ownership boundaries, and result integration."
scope: orchestrator-only
---

# Delegation Context

**ORCHESTRATOR-ONLY SKILL**: This skill governs delegation behavior and MUST only be loaded by orchestrator agents (e.g., `DevOrchestrator`, `tester`). Non-orchestrator workers, reviewers, auditors, and checkers MUST NOT load this skill for delegation purposes.

Ensure complete, unambiguous context passing when orchestrator agents delegate work to specialized subagents.

## Triggers

| Trigger | Description |
|---------|-------------|
| Orchestrator delegates to subagent | Any orchestrator agent calling a subagent for specialized analysis |
| Subagent handoff expected | Subagent output needs integration into parent artifact |
| Multiple subagents in sequence | Dependencies between subagent results |
| Ownership boundary crossing | Work moves between owned and unowned domains |
| Result integration from subagent | Subagent output needs to be merged into spec |

**Note**: Only orchestrator agents may trigger delegation. Non-orchestrator agents (workers, reviewers, auditors, checkers) have `permission.task: deny` and must return `needs_more_context` or `blocked` instead of delegating.

## Quick Reference

| Phase | Action | Key Principle |
|-------|--------|---------------|
| 1 | Define ownership boundaries | Know what you own vs what subagent owns |
| 2 | Pass complete context | Include task, workspace, evidence, decisions |
| 3 | Set handoff expectations | Specify exact output format and location |
| 4 | Integrate results | Map subagent findings into parent artifacts |
| 5 | Verify completeness | Check all subagent outputs are incorporated |

## Ownership Boundary

### Orchestrator Owns

- Specification discovery workflow
- Task workspace management
- Clarification loops with the user
- Subagent delegation and orchestration
- Synthesis of final artifacts
- Kanban visibility for the task

### Orchestrator Does Not Own

- Implementation delivery workflow
- Product-code editing outside spec artifacts
- Verification of implementation
- Code review of implementation changes
- Commit orchestration

### Subagent Owns

- Its specialized analysis domain
- Its output artifact (within spec workspace)
- Evidence and findings within its scope

### Subagent Does Not Own

- Final requirements or decisions
- User interrogation (except feature-triager in support role)
- Final specification synthesis

## Context Passing Rules

### What Must Be Passed

| Context Element | Description | Required |
|-----------------|-------------|----------|
| Task objective | What the overall task aims to achieve | Always |
| Task workspace path | `docs/specs/<task-id>/` | Always |
| Current artifact state | What's already known and decided | Always |
| Relevant repository evidence | From repo-scout or prior analysis | When available |
| Unresolved questions | Open items the subagent may help resolve | When applicable |
| Constraints | Known technical or business boundaries | Always |
| Expected output format | Exact structure and file path for output | Always |
| Handoff signal | How to notify orchestrator of completion | Always |

### Context Passing Template

```
Task: [Overall task objective]
Workspace: docs/specs/<task-id>/
Current state: [What's known, decided, assumed]
Your scope: [What you need to analyze]
Evidence available: [Relevant repo findings, decisions]
Expected output: [Artifact path and structure]
Return: [What to return to me]
```

### What Not to Pass

- Irrelevant context from unrelated analysis
- Personal opinions or unsupported assertions
- Unstructured raw data without summary
- Information the subagent cannot act on

## Handoff Expectations

### Before Delegation

- Define clear scope boundaries (what the subagent should analyze)
- Define output format (structure, file path, sections)
- Define integration points (how results map into spec sections)
- Set expectations for uncertainty handling (what to do if inconclusive)

### After Subagent Returns

- Integrate findings into appropriate spec sections
- Transfer evidence gaps into questions-log.md
- Transfer confirmed constraints into decision-log.md
- Note any contradictions or conflicts between subagent findings

### Handoff Verification

| Check | Description |
|-------|-------------|
| Output exists | Subagent artifact written to workspace |
| Format matches | Output follows expected structure |
| Scope respected | Subagent stayed within assigned scope |
| Evidence clear | Subagent distinguished evidence from inference |
| Returns expected | Subagent returned structured output per contract |

## Collaboration Model

| Subagent | Role | When to Delegate |
|----------|------|------------------|
| repo-scout | Repository reconnaissance, current system analysis | After initial clarification |
| feature-triager | Structured requirement clarification | When ambiguity map is large |
| design-planner | Design options, trade-offs, execution planning | When trade-offs need documentation |
| edge-case-harvester | Systematic edge case, failure mode enumeration | After core behavior defined |
| contract-impact-auditor | Contract compatibility, migration analysis | When contracts may change |
| non-functional-prober | Non-functional requirements probing | For production-bound features |
| traceability-checker | Completeness verification | Before declaring spec_ready |

## Result Integration

### How to Integrate Subagent Findings

| Subagent Output | Maps To (in spec.md) |
|-----------------|----------------------|
| repo-scout.md | Current state, relevant modules, constraints |
| edge-cases.md | Edge Cases, Validation Rules, Error Handling |
| contract-impact.md | API Contract, Event/Message Contract, Migration/Rollout |
| non-functional-requirements.md | Performance, Security, Observability sections |
| design-brief.md | Architecture, Options Considered sections |
| execution-plan.md | Future implementation planning (separate file) |
| feature-triager findings | Problem Statement, Goals, Actors, Acceptance Criteria |

### Contradiction Resolution

If subagent findings conflict:
1. Surface both positions explicitly
2. Note which subagent produced each finding
3. Escalate to orchestrator for resolution with user if needed
4. Record resolution in decision-log.md

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Passing incomplete context | Subagent misses critical constraints | Pass full task + workspace + evidence |
| No output format specified | Subagent returns unstructured data | Define exact structure and file path |
| Ignoring subagent output | Wasted delegation effort | Integrate all findings into spec |
| Subagent exceeding scope | Duplicates work or makes decisions | Define clear scope boundaries |
| Copying subagent output verbatim | Lacks synthesis | Synthesize and reconcile findings |
| Not surfacing contradictions | Hidden conflicts in spec | Surface and resolve contradictions |

## Verification Checklist

- [ ] Ownership boundaries clearly communicated to subagent
- [ ] Complete context passed: task, workspace, state, evidence, constraints
- [ ] Expected output format and location specified
- [ ] Scope boundaries defined (what subagent should and should not do)
- [ ] Handoff signal defined (how subagent indicates completion)
- [ ] Subagent output exists at expected path
- [ ] Output respects expected format and structure
- [ ] Findings integrated into appropriate spec sections
- [ ] Evidence gaps transferred to questions-log.md
- [ ] Confirmed constraints transferred to decision-log.md
- [ ] Contradictions between subagent findings surfaced and resolved
- [ ] No duplicate analysis between orchestrator and subagent
