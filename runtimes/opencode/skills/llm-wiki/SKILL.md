---
name: llm-wiki
description: Maintains persistent LLM-generated Markdown wiki projects from existing source notes, with external source roots, JSON manifests, deterministic source scanning, ingest, and active maintenance workflows.
license: MIT
user-invocable: true
metadata:
  version: 1.0.0
---

# LLM Wiki

Maintains a persistent Markdown wiki that is synthesized from source notes. The skill is project-agnostic: project-specific domains, folders, and rules live in each wiki project's `AGENTS.md` and `.state/project.json`.

## Triggers

- `create an LLM wiki` - initialize a new wiki project around existing notes.
- `ingest sources into wiki` - process new or changed source notes into wiki pages.
- `maintain wiki health` - repair index, coverage, links, stale claims, and open questions.
- `LLM wiki init` - create the project scaffold.
- `LLM wiki ingest` - scan source changes and update the generated wiki.

## Core Model

An LLM wiki project has three layers:

| Layer | Owner | Purpose |
|---|---|---|
| Source root | Human | Existing notes or documents used as source of truth. |
| Wiki root | LLM | Synthesized pages, cross-links, summaries, decisions, runbooks, and indexes. |
| State root | Tools | Machine-readable JSON manifests and scan outputs. |

Source files may live outside the wiki vault. This is the default pattern when a user already has a mature note structure.

## Project Layout

Recommended layout:

```text
<wiki-project>/
  AGENTS.md
  wiki/
    index.md
    log.md
    open-questions.md
  .state/
    project.json
    source_manifest.json
    latest_scan.json
```

`project.json` is the machine-readable configuration. `AGENTS.md` is the human-readable schema and agent instruction file.

## Commands

| Mode | Purpose | Main Output |
|---|---|---|
| `init` | Create project scaffold around an existing source root. | `AGENTS.md`, `wiki/`, `.state/project.json`, `.state/source_manifest.json` |
| `ingest` | Process new and changed source files into wiki pages. | Updated wiki pages, `index.md`, `log.md`, manifest hashes |
| `maintain` | Keep the wiki healthy and current. | Repaired index, coverage notes, open questions, maintenance log |

Do not add project- or domain-specific modes to this skill. Put domain behavior in the project's `AGENTS.md`.

## Mode: Init

Use `init` when the user wants to start a wiki project.

### Inputs

- `project_root`: where the wiki project lives.
- `source_root`: where source notes live. This may be outside `project_root`.
- `wiki_root`: usually `<project_root>/wiki`.
- `state_root`: usually `<project_root>/.state`.
- include/exclude globs for source scanning.

### Steps

1. Confirm the user wants a new wiki project at `project_root`.
2. Create the project scaffold with `scripts/init_project.py`.
3. Write `.state/project.json` with absolute paths.
4. Write `.state/source_manifest.json` as an empty manifest.
5. Explain that source files remain read-only and are not moved.

### Hard Rules

- Never move existing notes into `raw/` by default.
- Never edit source files during init.
- If migration or moving files is requested, treat it as a separate explicit operation.

## Mode: Ingest

Use `ingest` when the user wants the wiki updated from source changes.

### Required Scanner Step

Before reading source files, run the deterministic scanner:

```bash
python3 scripts/scan_sources.py --project-root <wiki-project> --output <wiki-project>/.state/latest_scan.json
```

The scanner compares current SHA-256 hashes against `.state/source_manifest.json` and returns only changed state:

- `new`
- `changed`
- `deleted`
- `unchanged_count`

The LLM must read only relevant new/changed files unless the user explicitly requests a full rebuild.

### Steps

1. Read `<project_root>/AGENTS.md` and `.state/project.json`.
2. Run `scripts/scan_sources.py` and inspect the JSON output.
3. If there are no changes, report that no ingest is needed.
4. Read new/changed source files.
5. Update or create wiki pages under `wiki_root`.
6. Update `wiki/index.md`, `wiki/open-questions.md`, and `wiki/log.md`.
7. After successful wiki updates, run scanner manifest update for processed files:

```bash
python3 scripts/scan_sources.py --project-root <wiki-project> --update-manifest --only-from-scan <wiki-project>/.state/latest_scan.json
```

### Evidence Rules

- Every factual wiki claim about a source must cite a source path.
- If the source does not support a claim, mark it as unverified or omit it.
- When sources disagree, keep both claims and add a contradiction note.

## Mode: Maintain

Use `maintain` when the user wants wiki health, not just a passive lint report.

### Scope

Maintain may:

- rebuild `wiki/index.md`;
- update `wiki/open-questions.md`;
- detect wiki pages without source coverage;
- detect source files not represented in the wiki;
- repair broken internal links when the fix is obvious;
- add missing cross-links when evidence is clear;
- append a `wiki/log.md` maintenance entry;
- suggest changes to `AGENTS.md` without applying them automatically.

### Hard Rules

- Maintain is allowed to edit `wiki_root` and `state_root` only.
- Maintain must not edit `source_root` unless the user explicitly requests it.
- Maintain must report unresolved ambiguity instead of inventing structure.

## Query Behavior

This skill does not need a separate query mode. When answering questions for a wiki project:

1. Read the project's `AGENTS.md`.
2. Read `wiki/index.md` first.
3. Read relevant wiki pages.
4. Read source files only when wiki coverage is insufficient or disputed.
5. Answer with citations to wiki and source paths.
6. If the answer is valuable as persistent knowledge, ask the user where to save it.

## Scripts

### `scripts/init_project.py`

Creates the project scaffold without moving source notes.

Usage:

```bash
python3 scripts/init_project.py --project-root PATH_TO_WIKI_PROJECT --source-root PATH_TO_SOURCE_NOTES --project-name PROJECT_NAME
```

The script writes `AGENTS.md`, `wiki/index.md`, `wiki/log.md`, `wiki/open-questions.md`, `.state/project.json`, and `.state/source_manifest.json` only when files are missing unless `--force` is used.

### `scripts/scan_sources.py`

Deterministically scans source files, computes SHA-256 hashes, compares with a JSON manifest, and writes a JSON diff.

Usage:

```bash
python3 scripts/scan_sources.py --project-root PATH_TO_WIKI_PROJECT --output PATH_TO_WIKI_PROJECT/.state/latest_scan.json
python3 scripts/scan_sources.py --project-root PATH_TO_WIKI_PROJECT --update-manifest --only-from-scan PATH_TO_WIKI_PROJECT/.state/latest_scan.json
```

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General failure |
| 2 | Invalid arguments |
| 3 | Missing file or directory |
| 10 | Validation failure |
| 11 | Verification failure |

## Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| Project-specific skill behavior | Skills can load in any project. | Put domain rules in project `AGENTS.md`. |
| Moving existing notes into `raw/` by default | It disrupts mature note structures. | Use external `source_root`. |
| Markdown as canonical manifest | It is hard to update safely. | Use JSON state files. |
| LLM scanning all sources by reading them | Expensive and unreliable. | Use deterministic scanner output. |
| Separate `rebuild-index` mode | It fragments maintenance. | Fold index repair into `maintain`. |

## Verification

After execution:

- [ ] Source root remains unchanged unless explicitly requested.
- [ ] Wiki files are under configured `wiki_root`.
- [ ] State files are under configured `state_root`.
- [ ] `source_manifest.json` is valid JSON.
- [ ] `scan_sources.py` reports new/changed/deleted sources correctly.
- [ ] `wiki/log.md` records the operation.

## Extension Points

1. **Search integration:** Add optional local search tooling when index-based navigation becomes insufficient.
2. **Schema templates:** Add more page templates without changing the core modes.
3. **Manifest enrichment:** Store source-to-page coverage after ingest.
4. **Validation scripts:** Add link and frontmatter validators when project conventions stabilize.
