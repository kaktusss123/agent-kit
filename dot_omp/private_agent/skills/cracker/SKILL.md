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

If bootstrap has no meaningful description, ask for intent before researching.

When evidence, decisions, spec, and verification are ready, call `task_mark_ready`. Fix any precise readiness failures it returns.

After readiness succeeds, tell the user the task is ready for approval/handoff. Do not start implementation.
