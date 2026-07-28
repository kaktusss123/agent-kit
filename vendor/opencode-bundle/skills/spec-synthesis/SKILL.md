---
name: spec-synthesis
description: "Synthesizes discovery evidence into an implementation-ready specification document following a fixed 24-section structure. Converts findings, decisions, and analysis artifacts into a coherent spec."
---

# Spec Synthesis

Transform discovery evidence from subagent artifacts into a complete, implementation-ready specification.

## Triggers

| Trigger | Description |
|---------|-------------|
| After all subagent analysis complete | All artifacts exist, ready to synthesize |
| Before declaring spec_ready | Final integration step |
| After resolving all blocking questions | Ambiguity resolved, decisions captured |
| When user requests spec review/update | Existing spec needs revision |

## Quick Reference

| Section | Content Source | Purpose |
|---------|---------------|---------|
| Overview | Task framing | Feature summary and scope |
| Problem Statement | Feature-triager | Why this exists |
| Goals | Feature-triager | Objectives |
| Non-goals | Feature-triager | Explicitly out of scope |
| Actors | Repo-scout + feature-triager | Who interacts |
| User Stories | Feature-triager | Scenario descriptions |
| Functional Requirements | All sources | What the system must do |
| Business Rules | Domain analysis | Constraints and invariants |
| Data Model | Repo-scout + edge-case-harvester | Schema and persistence |
| API Contract | Contract-auditor | Endpoints, payloads, errors |
| Event/Message Contract | Contract-auditor | Async contracts |
| UI/UX Behavior | Feature-triager + non-functional-prober | User-visible behavior |
| Validation Rules | Edge-case-harvester | Input validation |
| Permission Model | Feature-triager | AuthZ rules |
| Error Handling | Edge-case-harvester | Failure behavior |
| Edge Cases | Edge-case-harvester | Specific edge cases |
| Performance | Non-functional-prober | NFR targets |
| Security | Non-functional-prober | AuthN, data protection |
| Observability | Non-functional-prober | Logs, metrics, traces |
| Migration/Rollout | Contract-auditor + non-functional-prober | Migration plan |
| Dependencies | Repo-scout | Internal/external deps |
| Open Questions | Questions-log | Unresolved items |
| Assumptions | Assumptions-log | Temporary assumptions |
| Acceptance Criteria | Feature-triager | Verifiable completion |

## Process

### 1. Gather Source Artifacts

Collect from task workspace `docs/specs/<task-id>/`:

| Artifact | Required |
|----------|----------|
| `repo-scout.md` | Yes |
| `questions-log.md` | Yes |
| `decision-log.md` | Yes |
| `assumptions.md` | Yes |
| `edge-cases.md` | If edge-case-harvester ran |
| `contract-impact.md` | If contract-auditor ran |
| `non-functional-requirements.md` | If non-functional-prober ran |
| `design-brief.md` | If design-planner ran |
| `execution-plan.md` | If design-planner ran |

### 2. Map Evidence to Spec Sections

For each spec section, identify which source artifacts contain relevant content. Do not copy verbatim — synthesize findings into coherent narrative.

### 3. Check for Missing Coverage

Before writing, verify:

- [ ] Each mandatory coverage expectation has at least one section
- [ ] All resolved decisions from decision-log are reflected
- [ ] Edge cases with defined behavior are included
- [ ] Contract changes are documented with compatibility treatment
- [ ] Open questions are captured in Open Questions section
- [ ] Assumptions are clearly labeled as assumptions

### 4. Write Spec

Follow the 24-section output structure. Each section should be:
- **Complete**: Covers the topic without referencing external documents
- **Consistent**: Does not contradict other sections
- **Verifiable**: Contains testable or observable statements
- **Traceable**: Can be linked back to source decisions

## Hard Rules

| Rule | Description |
|------|-------------|
| 1 | Do not implement product code. Spec only. |
| 2 | Do not finalize spec while major ambiguity remains unresolved |
| 3 | Do not present inferred behavior as confirmed behavior |
| 4 | Do not treat "obvious" as a substitute for specification |
| 5 | Do not skip permissions, failure modes, or acceptance criteria |
| 6 | Do not overwrite prior decision or question history |
| 7 | Do not claim repository facts not evidenced by repo scouting |
| 8 | If user wants only specification, do not route toward implementation |

## Definition of Done

The spec is not complete until:

- [ ] `repo-scout.md` exists
- [ ] `questions-log.md` contains clarification history
- [ ] `decision-log.md` contains explicit decisions
- [ ] `assumptions.md` contains unresolved or temporary assumptions
- [ ] `spec.md` is implementation-ready (all 24 sections populated)
- [ ] `traceability.md` confirms coverage or lists remaining gaps
- [ ] All contradictions between sections resolved
- [ ] Each requirement traces to at least one acceptance criterion

## Anti-Patterns

| Anti-Pattern | Why | Instead |
|--------------|-----|---------|
| Spec-writing before clarification | Produces speculative content that needs rework | Resolve blocking questions first |
| Copying subagent output verbatim | Lacks synthesis, may contain contradictions | Synthesize and reconcile evidence |
| Skipping acceptance criteria | Spec is not verifiable without AC | Define clear, testable AC |
| Hiding assumptions as facts | Misleads implementer | Explicitly label assumptions |
| Self-contradictory sections | Confuses all readers | Cross-check all sections before finalizing |
| Omitting failure paths | Spec covers only happy path | Include error handling in every section |

## Verification Checklist

- [ ] All 24 sections present in `spec.md`
- [ ] No section contains unresolved ambiguity (marked in Open Questions)
- [ ] Every decision from decision-log.md reflected
- [ ] Every edge case from edge-cases.md with defined behavior included
- [ ] Every contract change from contract-impact.md documented
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] Assumptions clearly labeled with impact-if-wrong notes
- [ ] No implementation code in spec
- [ ] Contradiction-free across all sections
- [ ] Traceability pass completed (traceability.md exists)
