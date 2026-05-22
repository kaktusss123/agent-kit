---
name: agent-skill-design-review
description: "Advisory review skill for evaluating agent and skill design changes against curated recommendations, local OpenCode constraints, and evidence discipline"
---

# Agent and Skill Design Review

Use this skill when designing, modifying, or reviewing agents or skills for OpenCode.

## Triggers

| If the user says... | Then... |
|---|---|
| `agent-skill-design-review: {goal}` | Run the design review workflow |
| `review this agent design` | Run the design review workflow |
| `review this skill design` | Run the design review workflow |

## Quick Reference

| Input | Output | Duration |
|---|---|---|
| Agent or skill design artifact | Review report with findings and recommendations | Medium |

## Override Hierarchy

**This skill is advisory, not authoritative.** When recommendations conflict, apply this hierarchy:

1. **User decisions** — Explicit user instructions always override all other guidance.
2. **Local OpenCode docs** — Current OpenCode documentation and repository evidence override external articles.
3. **Repository evidence** — Observed file structure, commands, and behavior in the target repository override general recommendations.
4. **Task-specific specs** — Approved specifications for the current task override generic design patterns.
5. **External recommendations** — Articles, best practices, and external sources are advisory only.

External sources (Anthropic skill authoring, agent architecture articles, etc.) are useful but are **not SSOT**. They must be validated against local behavior before adoption.

## Process

### Phase 1: Gather Design Context

1. **Identify scope** — Determine whether the artifact is an agent definition, skill, plugin, or command.
2. **Load design guidance** — Read `references/design-guidance.md` for curated recommendations.
3. **Collect local constraints** — Identify OpenCode-specific constraints: permission model, skill discovery paths, plugin APIs, command override behavior.

**Verification:** All external recommendations are marked as advisory and subordinate to local evidence.

### Phase 2: Evaluate Against Criteria

Apply these evaluation lenses:

| Lens | Questions |
|---|---|
| **Context budget** | Is the design concise? Does it avoid bloating always-loaded context? |
| **Progressive disclosure** | Does SKILL.md stay under 500 lines? Are detailed workflows in reference files? |
| **Permission boundaries** | Are permissions least-privilege? Are dangerous operations denied or gated? |
| **Evidence discipline** | Does the design require citations for factual claims? Does it avoid guessing? |
| **Delegation safety** | Is delegation limited and explicit? Are subagent boundaries clear? |
| **Evaluation readiness** | Are there validation scenarios or evaluation criteria defined? |
| **Local compatibility** | Does the design work with OpenCode's permission model, skill discovery, and plugin APIs? |

**Verification:** Each lens produces findings with severity (Critical, High, Medium, Low, Info).

### Phase 3: Produce Review Report

Return a structured report:

```text
## DESIGN REVIEW COMPLETE
Scope: <agent|skill|plugin|command name>
Verdict: PASS | PASS_WITH_NOTES | FAIL | BLOCKED

Findings:
| id | severity | location | finding | evidence | remediation |
|---|---|---|---|---|---|
| R1 | <severity> | file:line | issue | quote or reference | required action |

Override hierarchy applied:
- User decisions: <applied or n/a>
- Local OpenCode docs: <applied or n/a>
- Repository evidence: <applied or n/a>
- External recommendations: <advisory only>

Residual risks:
- risk + why it remains
```

## Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| Treating external articles as SSOT | They may not match local OpenCode behavior | Validate against local docs and repository evidence |
| Bloating SKILL.md beyond 500 lines | Exceeds optimal context budget | Use progressive disclosure with reference files |
| Designing without permission boundaries | Creates security risk | Apply least-privilege permissions from the start |
| Skipping evaluation scenarios | Makes validation impossible | Define validation scenarios before finalizing design |
| Ignoring user decisions | Overrides all other guidance | Apply override hierarchy strictly |

## Verification

After execution:

- [ ] Override hierarchy is explicitly applied and documented
- [ ] External recommendations are marked as advisory
- [ ] Each evaluation lens has findings with severity
- [ ] Verdict is justified by findings
- [ ] Residual risks are documented

## References

- [`references/design-guidance.md`](references/design-guidance.md) — Curated design recommendations from external sources, marked as advisory
