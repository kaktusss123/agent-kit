---
description: "Discovery and specification workflow for a feature idea, bug, migration, or ambiguous engineering request. Main owns discovery and specification, investigates the repository before asking the user, asks only material product questions, delegates independent research, and produces an implementation-ready specification without implementing product code."
---

# Spec workflow

Act as the manager of discovery and specification.

Task: $ARGUMENTS

If the task is empty, use the goal already agreed in this conversation; if there is none, ask the user what to specify before doing anything else.

Do not implement product code unless the user explicitly leaves this workflow.

## Own the whole problem

Keep the user goal, confirmed decisions, important evidence, open questions, and acceptance boundary in the main session. Delegate bounded investigation, not ownership of the problem.

Use existing capabilities when relevant:

- `skill://grilling` for unresolved product or design choices;
- `skill://system-understanding` to trace current behavior;
- `skill://engineering-research` for version-sensitive external facts;
- `skill://code-archaeology` when history may explain a strange constraint;
- `skill://blast-radius` for risky downstream impact;
- `skill://codebase-design` for structural choices;
- `skill://verification-design` to define observable proof;
- `skill://specification` for the final contract.

## Investigate efficiently

Start with enough local reconnaissance to split the unknowns intelligently. Discover repository facts yourself before asking the user anything.

Fan out scouts only when their scopes are materially independent. Give each scout an explicit question and boundary, for example runtime flow, persistence, public contracts, or test architecture. Do not send multiple scouts over the same area merely for parallelism. Duplicate investigation only when an independent second opinion is worth the extra tokens.

Prefer one synthesis pass in main over chains of agents summarizing other agents.

## Ask only real questions

Ask the user only when different answers would change intended behavior, scope, compatibility, risk acceptance, or another externally visible decision.

Do not force an interview or a fixed number of questions. Small tasks may require none.

## Converge before writing the spec

Separate established facts from proposed decisions. Resolve material contradictions before presenting the final contract. When uncertainty can be settled cheaply by an experiment, use `skill://prototype` and keep the experiment disposable.

Write the final specification with `skill://specification`. Keep small work small. The output must be usable by a capable implementer entering cold, with observable acceptance and verification seams.

## Done

Finish when the requested behavior, important constraints, decisions, failure behavior, non-goals, and verification approach are clear enough that implementation does not require guessing product intent.
