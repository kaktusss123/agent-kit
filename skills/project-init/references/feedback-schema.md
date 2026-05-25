# Feedback Schema

Canonical internal reference for feedback file format and lifecycle.

## File Format

Feedback files live at `docs/feedback/feedback_<slug>.md` with the following frontmatter and body:

```markdown
---
name: <Human-readable title>
description: <One-line summary>
type: feedback
originSessionId: <current session ID if available>
---

## Why

<Concrete description of what was wrong or missing. Cite file paths, command output, or session observations.>

## How to apply

<Exact text or section change that AGENTS.md should contain.>
```

## Slug Rules

- Category prefix: one of `command`, `boundary`, `architecture`, `tooling`, `style`
- Short description: kebab-case, max 5 words
- Full slug: `<category>-<description>` (e.g., `command-missing-lint-rule`)
- Collision handling: append `-1`, `-2`, etc. incrementally

## Lifecycle

1. **Created** — `/feedback` command writes `feedback_<slug>.md`
2. **Consumed** — `/init --mode update` reads all `docs/feedback/feedback_*.md` entries
3. **Archived** — Immediately after consumption, move each file to `docs/feedback/archive/feedback_<slug>.md`
4. **Metadata** — Record `slug` + `archived_at` (ISO timestamp) in `.opencode/agents-freshness.json` under `feedback_processed[]`

## Freshness Registry Contract

The `feedback_processed` array in `.opencode/agents-freshness.json` contains minimal entries:

```json
{
  "feedback_processed": [
    { "slug": "command-missing-lint-rule", "archived_at": "2026-05-25T10:00:00Z" },
    { "slug": "style-comment-language", "archived_at": "2026-05-25T10:00:00Z" }
  ]
}
```

- `slug`: The feedback file slug (without `feedback_` prefix and `.md` suffix)
- `archived_at`: ISO 8601 timestamp when the file was archived
- No hash, status transitions, or additional metadata required

## Archive Behavior

- Archive directory: `docs/feedback/archive/`
- Files are moved (not copied) immediately after consumption
- Archive is append-only; never delete or modify archived files
- `/init --mode check` and `--mode dry-run` must NOT consume or archive any feedback files
