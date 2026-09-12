# LLM Wiki Project Rules

This project uses a persistent LLM-generated wiki synthesized from source notes.

## Configuration

Machine-readable configuration lives in `.state/project.json`.

## Ownership

- Source root is human-owned and read-only during wiki operations.
- Wiki root is LLM-owned and writable.
- State root is tool-owned and writable.
- Do not edit source files unless the user explicitly requests it.

## Source of Truth

Source files are the source of truth. Wiki pages are synthesized views and must cite source paths for factual claims.

## Wiki Conventions

- Use Obsidian-compatible Markdown links when linking within the wiki.
- Prefer stable, descriptive file names.
- Keep pages focused on one topic, component, decision, or workflow.
- Add an `Open Questions` section when evidence is incomplete.

## Required Files

- `wiki/index.md` catalogs wiki pages.
- `wiki/log.md` records ingest and maintenance operations.
- `wiki/open-questions.md` collects unresolved questions.
- `.state/source_manifest.json` stores source hashes and ingest state.

## Ingest Rules

1. Run the source scanner before reading source files.
2. Read only new or changed source files unless a full rebuild is requested.
3. Update affected wiki pages.
4. Update `wiki/index.md` and `wiki/log.md`.
5. Update `.state/source_manifest.json` only after successful wiki updates.

## Maintenance Rules

Maintenance is active repair, not only reporting. It may update wiki pages, index, log, and open questions. It must not modify source files.
