# Section Templates for Project AGENTS.md

Each section below shows the required structure with managed markers. Replace placeholders with project-specific values.

## Project Identity

```markdown
<!-- project-init:section:project-identity -->
# Project Identity

- **Name:** <project-name>
- **Language/Stack:** <detected languages and frameworks>
- **Package Manager:** <npm|yarn|pnpm|pip|uv|go mod|etc.>
- **Task Runner:** <make|npm scripts|just|etc.>
- **Test Framework:** <pytest|jest|vitest|go test|etc.>
- **Lint/Format/Typecheck:** <detected tools>
<!-- /project-init:section:project-identity -->
```

## Commands

```markdown
<!-- project-init:section:commands -->
# Commands

| Command | Purpose | Status |
|---|---|---|
| `<command>` | <description> | <verified|unverified> |

**Notes:**
- Commands marked `verified` were checked against actual project files or safe existence checks.
- Commands marked `unverified` were inferred from project structure and require manual confirmation.
<!-- /project-init:section:commands -->
```

## Architecture / File Map

```markdown
<!-- project-init:section:architecture -->
# Architecture / File Map

<High-level description of project structure, entry points, and module boundaries.>

**Key directories:**
- `<dir>/` — <purpose>
- ...

**Entry points:**
- `<file>` — <description>
- ...

**Evidence:** <cite inspected files>
<!-- /project-init:section:architecture -->
```

## Code Style and Tooling

```markdown
<!-- project-init:section:code-style -->
# Code Style and Tooling

- **Language:** <language version>
- **Formatter:** <tool> — run with `<command>`
- **Linter:** <tool> — run with `<command>`
- **Type Checker:** <tool> — run with `<command>`
- **Test Runner:** <tool> — run with `<command>`
- **Conventions:** <naming, structure, or other project-specific rules>
<!-- /project-init:section:code-style -->
```

## Golden Samples

```markdown
<!-- project-init:section:golden-samples -->
# Golden Samples

<Only include if confident evidence exists. Reference files that exemplify project conventions.>

- `<file>` — exemplifies <convention>
- ...
<!-- /project-init:section:golden-samples -->
```

## Utilities

```markdown
<!-- project-init:section:utilities -->
# Utilities

<Only include if confident evidence exists. List project-specific helper scripts or tools.>

- `<script>` — <purpose>
- ...
<!-- /project-init:section:utilities -->
```

## Always / Ask / Never Boundaries

```markdown
<!-- project-init:section:boundaries -->
# Always / Ask / Never Boundaries

**Always:**
- Verify evidence before making claims about project behavior.
- Inspect relevant files before changing them.
- Run relevant checks (lint, test, typecheck) before claiming done on code changes.

**Ask First:**
- Adding new dependencies.
- Destructive operations (database migrations, schema changes).
- Changes to public API or contract boundaries.
- Broad refactors affecting multiple modules.
- Modifications outside the current workspace.

**Never:**
- Commit secrets or credentials.
- Use `--no-verify` to skip pre-commit hooks.
- Overwrite human-authored rules without review.
- Modify generated or vendored files unless explicitly requested.
- Execute remote git, network, package-install, cloud, or SSH commands.
<!-- /project-init:section:boundaries -->
```

## Feedback Memory

```markdown
<!-- project-init:section:feedback-memory -->
# Feedback Memory

Approved user corrections are stored in `docs/feedback/feedback_<slug>.md` files.
These entries influence future agent behavior without bloating this file.

**Schema:** See `skills/project-init/references/feedback-schema.md` for format and lifecycle.

**Approved entries:**
- `<slug>` — <one-line description> (see `docs/feedback/feedback_<slug>.md`)
- ...

**How to add:** When a user approves a correction, create a new feedback file following the schema in `skills/project-init/references/feedback-schema.md` and add a pointer here.
<!-- /project-init:section:feedback-memory -->
```

## When Stuck / Verification

```markdown
<!-- project-init:section:when-stuck -->
# When Stuck / Verification

If uncertain about project behavior:

1. Inspect the relevant source files and tests.
2. Run non-destructive validation commands (lint, test, typecheck).
3. If evidence is insufficient, state uncertainty and ask the user.
4. Do not present assumptions as facts.

**Verification commands:**
- `<lint command>`
- `<test command>`
- `<typecheck command>`
<!-- /project-init:section:when-stuck -->
```
