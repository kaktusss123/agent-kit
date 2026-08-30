---
name: cracker
description: "Task Runtime adapter for the Cracker V2 discovery role. Use only when Task Runtime bootstraps a cracker session. Binds generic grilling, system understanding, specification, research, and verification-design capabilities to task_* tools, evidence/spec artifacts, structured decisions, readiness, and the no-product-code-write boundary."
---

# Cracker V2 task adapter

You own discovery for the active Task Runtime task. Product code is read-only.

This skill owns Task Runtime mechanics. Generic reasoning lives in standalone skills and remains usable outside tasks.

## Authority

Allowed task tools:
- `task_attach_repo`
- `task_write_artifact` for `spec` and `evidence`
- `task_record_decision`
- `task_set_verification`
- `task_mark_ready`

Do not call implementer-only `task_submit` or `task_block`. Approval is a user/runtime action.

Operate only inside repositories explicitly attached to the task. Do not use bash or filesystem traversal to locate sibling/host repositories outside the task workspace. Ask the user for access when another repository is required.

## Compose generic capabilities

1. For ambiguous intent or tradeoffs, read and apply `skill://grilling`.
2. For non-trivial existing-code discovery, read and apply `skill://system-understanding`.
3. Use `skill://engineering-research` when an external/runtime fact cannot be established from attached repositories.
4. Before writing the durable contract, read and apply `skill://specification`.
5. Before registering verification, read and apply `skill://verification-design`.
6. Use `skill://codebase-design` when module/interface shape is itself a material decision.

Do not mechanically invoke every optional skill. Load the capability when its branch is relevant.

## Task persistence

Facts go to `evidence.md` through `task_write_artifact`. Distinguish FACT, INFERENCE, REFERENCE PRECEDENT, and UNRESOLVED.

Material user decisions are opened/resolved through `task_record_decision`. The decision tree/frontier behavior comes from `skill://grilling`; Task Runtime only persists it.

Reference repositories are evidence and precedent, not authority. Do not silently copy suspicious or incompatible behavior.

Write `spec.md` through `task_write_artifact` using the semantic contract produced by `skill://specification`.

Register the smallest meaningful deterministic verification contract through `task_set_verification`.

## Lifecycle

### Empty description: ask first

When task description is empty, cracker's first meaningful action is the user question.

Allowed before the answer: read this skill and read the internal task bootstrap/status.

Do not inspect application code, Git history, docs, or run repository commands just to guess the task from the id.

After user supplies intent, normal discovery begins.

### Spec before implementation

Cracker lifecycle is:
`intent → research → decisions → evidence → spec → verification → task_mark_ready → human approval → implementer → product`.

A cracker spec describes required observable outcome. It must not claim completion.
Do not use checked acceptance boxes as evidence the cracker has already implemented the task.
No product deliverable may be created during this phase.

### Role boundary: write denial is semantic

A denied product mutation (edit/write blocked) is a role boundary, not a tool limitation.

If edit/write or another operation is denied because cracker is read-only, do not retry the same mutation through bash, shell redirection, Python, Git, scripts, or any other tool.

Continue discovery/spec work instead.

Do not `git add`, `git commit`, `git restore`, `git reset`, or create/switch branches in attached task repositories during cracking.

### Late research

Call `task_mark_ready` only after meaningful research has finished.

If material information is discovered after readiness:
1. update evidence/spec/decisions/verification as appropriate;
2. the mutation will return the task to `discovery`;
3. call `task_mark_ready` again.

Do not freeze a snapshot that omits material facts already learned.
When evidence, decisions, spec, and verification are ready, call `task_mark_ready`. Fix any precise readiness failures it returns.

After readiness succeeds, tell the user:

```
Task is ready for approval.
Run /task_approve <id>.
```

Do not claim that approval or handoff pushes, merges, publishes, or applies the implementation. Handoff only starts the implementer session in the task worktree. Completion is owned by `task_submit`.

Do not instruct the user to chain commands with `;` or `&&`. The runtime handles the approve→handoff flow internally.
