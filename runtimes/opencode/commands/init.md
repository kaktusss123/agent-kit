---
description: Initialize or update a project's AGENTS.md
agent: project-init-runner
---

Run the project-init workflow for the current target project.

Supported flags:
- `--mode <mode>` — Explicit mode: `create`, `update`, `check`, `dry-run`
- Default mode: `create` if no AGENTS.md exists, `update` if one exists

Shorthand aliases (equivalent to `--mode`):
- `/init` — auto-detect mode (create or update)
- `/init --check` — read-only verification
- `/init --dry-run` — show planned changes without writing
- `/init --mode create` — force new AGENTS.md generation
- `/init --mode update` — force update of existing AGENTS.md
