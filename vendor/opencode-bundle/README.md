# OpenCode engineering framework

This bundle keeps workflows small and uses agents only when a separate model, isolated context, or independent opinion is worth the cost.

## Core agents

Primary agents:
- `General`: direct-action coding and ordinary engineering work, code model.
- `spec-analyst`: adaptive discovery that writes a durable spec, analysis model.
- `dev-orchestrator`: manager-only multi-stage implementation, control model.

Hidden model-bound agents:
- `repo-scout`: bounded repository research, research model.
- `designer`: architecture and design decisions, design model.
- `implementer`: code changes for one coherent slice, code model.
- `reviewer`: fresh-context executable verification and code review, review model.
- `security-reviewer`: adversarial security review, security model.
- `committer`: narrow checkpoint commit step, protocol model.

The legacy `tester`, `test-planner`, `test-writer`, and `test-reviewer` remain temporarily available as a separate workflow. They are intentionally not part of the core development loop and should be redesigned independently.

## Main development loop

`dev-orchestrator` owns the whole-task context. Product-code details stay in worker sessions.

For each coherent changing slice:

1. `implementer` changes code and runs focused feedback.
2. `committer` creates an immutable checkpoint.
3. `reviewer` verifies the exact commit in fresh context and applies relevant review lenses.
4. `security-reviewer` runs only when security is materially involved.
5. Blocking findings return to the implementer for another checkpoint.

There are no review tiers and no domain-reviewer zoo. Contracts, tests, performance, and complexity are lenses loaded by the generic reviewer when triggered.

## Specification handoff

`spec-analyst` always produces a durable artifact unless the user explicitly requests chat-only output. A clean implementation session consumes that spec through `/execute-spec`.

Transient subagent output is evidence for the current session, not the cross-session contract.

## Skills

Core generic skills contain reusable engineering judgment:
- `engineering-core`
- `system-understanding`
- `blast-radius`
- `codebase-design`
- `specification`
- `implementation`
- `verification-design`
- `change-verification`
- `code-review`
- `git-commit`
- `security-review`

Existing generic skills such as `find-docs`, project initialization helpers, and `testing-python` remain available where useful.

## Kanban

Kanban is intentionally absent from the core workflow. Revisit durable task-state support only after real sessions show that main-session context and durable specs/commits are insufficient.
