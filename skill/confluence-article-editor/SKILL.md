---
name: confluence-article-editor
description: Use when user asks to edit a Confluence article locally, e.g. "отредактируем статью 123456", "редактировать статью 123456", provides a wiki.cloud.ru page URL. Pulls the page to Markdown, tracks the base version, and uploads only after conflict checks.
---

# Confluence Article Editor

Use this skill when the user wants to edit a Confluence Cloud article locally instead of using the web editor.

## Safety Model

The skill uses optimistic concurrency with a three-way comparison:

| Artifact | Meaning |
|----------|---------|
| Base | Markdown and version pulled at edit start |
| Local | User-edited Markdown file |
| Remote | Latest Confluence page fetched before upload |

Never upload local Markdown until the latest remote version is compared against the saved base version.

## Storage Layout

Store files under `./confluence-edits/` in the current workspace.

```text
confluence-edits/
├── <page-id>-<title-slug>.md
├── .state/
│   └── <page-id>.json
└── .snapshots/
    ├── <page-id>.base.md
    ├── <page-id>.remote.md
    └── <page-id>.merged.md
```

State file shape:

```json
{
  "page_id": "123456",
  "title": "Page Title",
  "local_file": "confluence-edits/123456-page-title.md",
  "base_snapshot": "confluence-edits/.snapshots/123456.base.md",
  "base_version": 7,
  "base_updated_at": "2026-04-24T12:00:00.000Z",
  "pulled_at": "2026-04-24T12:05:00.000Z"
}
```

## Phase 1: Start Editing

1. Check that an Atlassian/Confluence MCP server is available.
   - Accept exact or similar tool names, such as `atlassian_confluence_get_page` and `atlassian_confluence_update_page`.
   - If no suitable tool is available, stop and show the user the full contents of `./INSTALL_MCP.md` from this skill directory.
2. Parse the user input.
   - Accept a numeric page ID directly.
   - Accept `wiki.cloud.ru` URLs and extract `pageId=<id>` or `/pages/<id>/...`.
   - If no page ID can be extracted, ask the user for a page ID or URL.
3. Fetch the page with metadata and Markdown conversion:
   - Use `atlassian_confluence_get_page` with `page_id`, `include_metadata: true`, and `convert_to_markdown: true`.
4. If fetching fails, report the most likely cause from the tool error:
   - Authentication/token error: token is missing, expired, or invalid.
   - Permission error: user lacks access to the Confluence space or page.
   - Not found: page ID is wrong or belongs to another site.
   - Conversion error: MCP server fetched the page but failed to convert content to Markdown.
   - Network/server error: Confluence or MCP server is unavailable.
5. Create `./confluence-edits/`, `./confluence-edits/.state/`, and `./confluence-edits/.snapshots/` if needed.
6. Save the page content to `<page-id>-<title-slug>.md`.
7. Save the exact pulled Markdown to `.snapshots/<page-id>.base.md`.
8. Save metadata to `.state/<page-id>.json`, including the Confluence version number.
9. Tell the user:
   - The local file path.
   - The base Confluence version.
   - To edit the file and tell the agent when editing is finished. Do not require an exact phrase; accept natural completion messages such as `готово`, `закончил`, `можно загружать`, or equivalent wording.

## Phase 2: Upload After User Finishes Editing

1. Use the state file for the current edit session that was created in Phase 1.
   - The normal workflow is one page per agent session: pull, user edits one file, upload.
   - Do not scan for unrelated sessions unless the current session context was lost.
   - If the current session context is lost, ask the user for the page ID or local Markdown path.
2. Read the local Markdown file and base snapshot.
3. Fetch the latest remote page again with metadata and Markdown conversion.
4. Compare the latest remote version to `base_version`.
5. If the remote version is unchanged:
   - Upload the local Markdown with `atlassian_confluence_update_page`.
   - Preserve the existing page title unless the user explicitly asked to rename it.
   - Report the new Confluence version or the tool's update confirmation.
6. If the remote version changed:
   - Save the latest remote Markdown to `.snapshots/<page-id>.remote.md`.
   - Read `./CONFLICTS.md` from this skill directory.
   - Follow its conflict-resolution workflow before uploading anything.

## Diff Preview Requirements

Before any upload, summarize changes relative to the saved base snapshot:

| Diff | Purpose |
|------|---------|
| Base → Local | User's edits that are about to be uploaded |
| Base → Remote | Changes made in Confluence while the user edited locally |
| Merged → Remote | Final delta after conflict resolution |

Show non-conflicting remote changes too. The user must understand both their local changes and the concurrent remote changes.

## Error Reporting

Report errors in this structure:

```markdown
Не удалось выполнить операцию с Confluence.

**Что произошло:** <short factual error>
**Вероятная причина:** <token/permission/not found/conversion/network/unknown>
**Что проверить:** <specific next action>
```

Do not guess silently. If the tool error is ambiguous, say that the exact cause is unclear and include the raw error summary.

## Verification Checklist

- [ ] MCP tools are present before fetching or uploading.
- [ ] Page ID is extracted from a direct ID or `wiki.cloud.ru` URL.
- [ ] Local Markdown file name contains the page ID and title slug.
- [ ] Base snapshot and state file are saved before telling the user to edit.
- [ ] Latest remote page is fetched before upload.
- [ ] Remote version is compared against the saved base version.
- [ ] Conflicts route through `CONFLICTS.md` when the remote version changed.
- [ ] Non-conflicting concurrent remote changes are shown to the user.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Uploading without refetching remote | Can overwrite concurrent edits | Always compare latest remote to base |
| Tracking only the latest version | Hides what changed during local editing | Store the original base version and snapshot |
| Using page title as the only identifier | Titles can change and collide | Key state by page ID |
| Suppressing MCP errors | User cannot fix auth or permission issues | Classify and report the failure cause |
| Auto-resolving conflicting semantic edits | Can corrupt Confluence content | Ask the user to resolve conflict markers |
