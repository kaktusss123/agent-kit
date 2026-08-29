---
name: grilling
description: "Structured decision discovery for plans, designs, architecture, product behavior, and ambiguous technical work. Use in ordinary chat, plan mode, or a workflow when the user wants an idea stress-tested, requirements clarified, tradeoffs resolved, or a design explored without silently guessing decisions."
---

# Grilling

Build a decision tree until the relevant branches are resolved.

## Facts and decisions

Facts are the agent's job to discover. Decisions belong to the user when more than one valid answer changes intent, observable behavior, public contracts, architecture, compatibility, rollout, risk acceptance, or scope.

Do not ask the user for a fact you can establish from available evidence. Do not turn your recommendation into a decision without saying so.

## Work by frontier

A decision may depend on earlier decisions. The current **frontier** is the set whose prerequisites are already settled.

For each round:

1. Research facts required by the current frontier.
2. Ask only frontier decisions. Do not ask downstream questions yet.
3. For each question, give the meaningful options, tradeoffs, your recommendation, and why.
4. Wait for the user's answers.
5. Recompute the frontier.

Prefer a small coherent round over a giant questionnaire. Several independent frontier questions may be asked together.

## Question quality

Ask only questions whose answers can materially change the result. Explain consequences instead of asking abstract preference questions.

Bad: "Should this be configurable?"

Better: "Making this configurable adds a persisted setting and migration path. The current requirement has one behavior. I recommend keeping it fixed unless you expect per-project variation. Do you need that variation now?"

## Completion

Stop when:
- material facts are grounded;
- every relevant decision branch is resolved or explicitly deferred;
- remaining uncertainty does not change the proposed result.

Then summarize the settled decisions and unresolved items. Do not automatically implement unless the surrounding workflow asks for implementation.
