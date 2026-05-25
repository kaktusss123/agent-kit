---
description: Capture context-aware feedback from the current session and write a schema-compliant feedback file
---

# Feedback Command

Derive a concrete feedback entry from the current session context and the user's brief instruction, then write it to the project feedback directory.

## Context

This command runs in the **same agent and session context** where the work happened. Do not delegate to a subagent or spawn a new context.

## Inputs

- `$ARGUMENTS` — Brief user instruction describing what feedback to capture (e.g., "AGENTS.md test command is wrong", "missing lint rule for new module")

## Workflow

1. **Infer concrete feedback from current session context**:
   - Review recent work, file changes, command output, or observations from this session.
   - Combine session evidence with `$ARGUMENTS` to derive a specific, actionable feedback entry.
   - Do not ask the user to restate what went wrong — use what you already know from this session.

2. **Determine the feedback slug**:
   - Category must be one of: `command`, `boundary`, `architecture`, `tooling`, `style`.
   - Short description is kebab-case, max 5 words.
   - Check `docs/feedback/` for existing files with the same slug.
   - If a collision exists, append `-1`, `-2`, etc. incrementally until a unique filename is found.

3. **Write the feedback file** (when current agent has edit permission):
   - Target path: `docs/feedback/feedback_<slug>.md`
   - Use the schema from `docs/feedback/README.md`:
     ```markdown
     ---
     name: <Human-readable title>
     description: <One-line summary>
     type: feedback
     originSessionId: <current session ID if available>
     status: open
     ---

     ## Why

     <Concrete description of what was wrong or missing. Cite file paths, command output, or session observations.>

     ## How to apply

     <Exact text or section change that AGENTS.md should contain.>
     ```

4. **Display-only fallback** (when current agent does not have edit permission):
   - Render the complete draft feedback file content in chat.
   - Instruct the user to save it manually to `docs/feedback/feedback_<slug>.md`.
   - Do not delegate to a subagent to write the file.
   - Do not attempt to bypass permission restrictions.

## Rules

- Do not specify `agent:` or `subtask:` in this command.
- Do not delegate feedback writing to a subagent.
- Do not create placeholder or empty feedback files.
- Do not modify unrelated files outside `docs/feedback/`.
