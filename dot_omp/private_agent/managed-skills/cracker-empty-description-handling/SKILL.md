---
name: cracker-empty-description-handling
description: "Cracker/spec-writer protocol when a task arrives with an empty or placeholder description: ask for intent before researching, and prefer fixing the upstream workflow to capture missing input."
---

# Cracker / spec-writer: empty-description handling

## Trigger
You are about to begin work as the cracker skill (or any spec-writer / planner role). The task arrives with only a task-id and a placeholder like "Describe the task" — no real description.

## Rule
Do NOT start repository research, do NOT read files speculatively, do NOT draft a spec from the task name alone.

## Required first action
1. Acknowledge the task id and primary repo so the user knows you registered the request.
2. Ask the user for intent: what is this task for, what needs to change, what are the constraints.
3. Optionally propose the next concrete setup steps (e.g. "add reference repos via /task_add_repo") and ask the user to confirm or correct.

Only after the user describes the task in their own words should research begin.

## Source-side fix
When the upstream workflow that fires the agent (a slash command, a script, an API) can capture the missing input at the source, fix that workflow instead of relying on the agent to ask. Examples:
- `task_init` should call `ctx.ui.input` for the description before firing the cracker prompt.
- A CLI tool should require `--description` or read from stdin before dispatching the agent.

This makes the agent never receive a description-less task and removes the temptation to research on a bare task name.

## Why this matters
The user reported this exact failure mode: they intentionally left a task description empty expecting setup + clarifying questions. Instead, the agent dove into research on the bare task name, wasting cycles and producing speculative work. The correct behavior is a short dialogue first, then research once intent is clear.
