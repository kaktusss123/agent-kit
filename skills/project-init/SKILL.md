---
name: project-init
description: "Analyzes a target repository and creates or updates the project root AGENTS.md with project-specific sections, boundaries, and feedback memory pointer"
---

# Project Init

Use this skill when onboarding a new project or updating an existing project's AGENTS.md.

## Triggers

| If the user says... | Then... |
|---|---|
| `/init` | Run the project-init workflow via project-init-runner |

## Quick Reference

| Input | Output | Duration |
|---|---|---|
| Target project root, mode | Created/updated AGENTS.md or dry-run summary | Medium (1-5 min) |

## Modes

| Mode | Behavior |
|---|---|
| `create` | Generate a new AGENTS.md from scratch |
| `update` | Read existing AGENTS.md, preserve human content, update managed sections |
| `check` | Read-only verification of existing AGENTS.md accuracy |
| `dry-run` | Show planned changes without writing anything |

## Process

### Phase 1: Resolve Target and Validate

1. **Resolve target root** — Determine the target project root directory from the current working directory or explicit argument.
2. **Validate write scope** — Confirm the target is not the global opencode config root (`~/.config/opencode`). If the user explicitly requests mutation of the global config, decline and explain that `/init` operates on project roots only.
3. **Check existing AGENTS.md** — Read the existing file if present; detect symlinks and warn before writing to symlink targets.

**Verification:** Target root is resolved and write scope is validated before any mutation.

### Phase 2: Gather Repository Evidence

1. **Detect stack** — Identify language(s), package manager, task runner, test framework, lint/format/typecheck commands by inspecting project files.
2. **Detect architecture** — Identify top-level directories, entry points, and module boundaries.
3. **Detect commands** — Extract build, test, lint, and run commands from package.json, Makefile, pyproject.toml, or equivalent.
4. **Mark verification status** — Commands are `unverified` until checked against actual project files or safe existence checks.

**Verification:** All detected facts cite inspected files or command output.

### Phase 3: Generate or Update AGENTS.md

1. **Build sections** — Construct required sections using the templates in `references/section-templates.md`.
2. **Apply managed markers** — Wrap generated sections with `<!-- project-init:section:<slug> -->` and `<!-- /project-init:section:<slug> -->` markers.
3. **Preserve human content** — In `update` mode, keep all content outside managed markers unchanged.
4. **Add boundaries** — Include project-specific Always/Ask/Never boundaries.
5. **Add feedback memory pointer** — Include a section linking to `docs/feedback/feedback_*.md` entries.

**Verification:** Generated content passes the secret-scan heuristic in `references/secret-scan-heuristic.md` before write.

### Phase 4: Write and Report

**Write boundary:** Steps 1 through 4 apply ONLY in `create` and `update` modes. In `check` or `dry-run` mode, skip all writes (no AGENTS.md, no freshness metadata, no temp files). Report only.

1. **Atomic write** (create/update only) — Write to a temp file in the target directory, then rename to AGENTS.md.
2. **Ensure directory exists** (create/update only) — If `.opencode/` does not exist in the target root, run `mkdir -p <target_root>/.opencode` before writing the freshness file.
3. **Create empty freshness file** (create/update only) — Run `touch <target_root>/.opencode/agents-freshness.json` to create the empty file. This is required because the `edit` tool cannot create a new file.
4. **Edit freshness metadata** (create/update only) — Use the `edit` tool to update `.opencode/agents-freshness.json` with ISO timestamp and verification summary. If the edit fails after the touch succeeds, return `blocked` with the error details; do not delete or clean up the touched file.
5. **Report** — Return the structured summary with target root, mode, detected stack, command counts, written files, and warnings.

**Verification:** Freshness metadata is written only after successful AGENTS.md write. In check/dry-run modes, no files are modified and no metadata is updated.

## Validation Scenarios

Before considering the skill stable, verify:

1. **Dry-run without AGENTS.md** — Draft contains required sections, managed markers, and no secret values.
2. **Update with custom content** — Human-authored content outside managed markers is preserved.
3. **Nested directory resolution** — Running from a subdirectory writes to the project root AGENTS.md, not the current subdirectory.

## Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| Writing to global opencode AGENTS.md in project-init mode | Pollutes every session | Write only to target project root |
| Marking commands as verified without checking | Breaks trust | Run existence checks or mark unverified |
| Full overwrite of existing AGENTS.md | Loses human-authored content | Preserve content outside managed markers |
| Including secret values in generated docs | Security risk | Use placeholders and redact sensitive values |
| Generating scoped/nested AGENTS.md in v1 | Out of scope | Generate only root AGENTS.md with monorepo warning if applicable |
| Executing remote git or network commands | Violates least-privilege | Use only local file inspection and local git commands |

## Verification

After execution:

- [ ] Target root is resolved and is not the global opencode config root
- [ ] Generated content contains required sections with managed markers
- [ ] Secret-scan heuristic passes with no secret values in output
- [ ] Existing human content is preserved in update mode
- [ ] Freshness metadata is valid JSON with ISO timestamp
- [ ] Commands are marked verified or unverified appropriately
- [ ] No scoped/nested AGENTS.md files were created

## References

- [`references/section-templates.md`](references/section-templates.md) — Required section templates and managed marker format
- [`references/secret-scan-heuristic.md`](references/secret-scan-heuristic.md) — Secret detection patterns and entropy checks
