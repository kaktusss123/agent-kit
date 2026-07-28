# Feedback Memory

This directory stores project-specific corrections captured by `/feedback` and consumed by `/init --mode update` on the next AGENTS.md refresh.

## Usage

1. Run `/feedback <short instruction>` while you are in the same session where the issue happened.
2. The current agent writes a `feedback_<slug>.md` file here with a concrete correction.
3. On the next `/init --mode update`, the runner reads every `feedback_*.md`, incorporates the corrections into the relevant AGENTS.md sections, and archives each file into `archive/`.

Do not edit `feedback_*.md` files manually unless the archived copy under `archive/` is the source of truth — the archive is append-only.

## File Format

Every `feedback_*.md` follows this schema:

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

- Category prefix: one of `command`, `boundary`, `architecture`, `tooling`, `style`.
- Short description: kebab-case, max 5 words.
- Full filename: `feedback_<category>-<description>.md`.
- Collisions: append `-1`, `-2`, etc. incrementally.

## Lifecycle

| Stage | Where | When |
|---|---|---|
| Created | `docs/feedback/feedback_<slug>.md` | `/feedback` writes the file |
| Consumed | read into AGENTS.md | `/init --mode update` only |
| Archived | `docs/feedback/archive/feedback_<slug>.md` | immediately after consumption |
| Tracked | `.opencode/agents-freshness.json` `feedback_processed[]` | along with the archive move |

`/init --mode check` and `--mode dry-run` must NOT consume or archive any feedback files.
