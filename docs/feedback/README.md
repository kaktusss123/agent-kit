# Feedback Schema

Project-scoped feedback memory for agent rules and onboarding accuracy.

## Purpose

When a project's AGENTS.md contains incorrect commands, stale references, or missing boundaries, agents record feedback entries here. The `project-init-runner` reads these entries during `/init --mode update` to improve accuracy.

## Feedback Entry Format

Each feedback entry is a Markdown file named `docs/feedback/feedback_<slug>.md`.

### Slug Rule

- Slug format: `<category>-<short-description>`
- Category must be one of: `command`, `boundary`, `architecture`, `tooling`, `style`
- Short description is kebab-case, max 5 words
- **Collision-safe numeric suffix**: if a slug already exists, append `-1`, `-2`, etc. (e.g., `command-missing-test-script-1`). Increment deterministically by checking existing files.
- Examples:
  - `command-missing-test-script`
  - `boundary-allow-node-modules-edit`
  - `architecture-wrong-entrypoint`
  - `command-missing-test-script-1` (collision fallback)

### Template

Each feedback file uses YAML frontmatter and two body sections:

```markdown
---
name: <Human-readable title>
description: <One-line summary of the issue>
type: feedback
originSessionId: <optional session ID that generated this entry>
status: <open|resolved|archived>  # optional; defaults to open
---

## Why

<Describe what was wrong or missing in AGENTS.md. Cite the file, command output, or observation that proves the issue.>

## How to apply

<What AGENTS.md should say instead. Concrete text or section change.>

## Resolution

<!-- Filled when status is resolved. Date, session, and brief note on what was applied. -->
```

## Project-Scoped Default

- Feedback entries live in `<project-root>/docs/feedback/`.
- Each project maintains its own feedback directory; entries are not shared across projects.
- Agents should check for existing feedback entries before creating duplicates.
- The `project-init-runner` merges resolved feedback into AGENTS.md during update mode.

## Lifecycle

1. **Create**: Agent or user discovers an inaccuracy and writes a new `feedback_<slug>.md`.
2. **Review**: Next `/init --mode update` run reads open entries and applies fixes.
3. **Resolve**: Applied entries are marked `status: resolved` with a resolution note in the `## Resolution` section.
4. **Archive**: Resolved entries older than 30 days may be moved to `docs/feedback/archive/`.
