# Confluence Edit Conflict Resolution

Use this file when a Confluence page changed remotely after the local Markdown copy was pulled.

## Inputs

| Name | Path |
|------|------|
| Base | `confluence-edits/.snapshots/<page-id>.base.md` |
| Local | `confluence-edits/<page-id>-<title-slug>.md` |
| Remote | `confluence-edits/.snapshots/<page-id>.remote.md` |
| Merged | `confluence-edits/.snapshots/<page-id>.merged.md` |

## Step 1: Show What Changed

Show the user both change sets before resolving conflicts:

1. Base → Local: edits made in the local Markdown file.
2. Base → Remote: edits made in Confluence while the user was editing.

Prefer `git diff --no-index` because it works outside a Git repository:

```bash
git diff --no-index -- confluence-edits/.snapshots/<page-id>.base.md confluence-edits/<page-id>-<title-slug>.md
git diff --no-index -- confluence-edits/.snapshots/<page-id>.base.md confluence-edits/.snapshots/<page-id>.remote.md
```

If side-by-side tools are available, use them for readability:

```bash
git diff --no-index --word-diff=color -- confluence-edits/.snapshots/<page-id>.base.md confluence-edits/<page-id>-<title-slug>.md
git diff --no-index --word-diff=color -- confluence-edits/.snapshots/<page-id>.base.md confluence-edits/.snapshots/<page-id>.remote.md
```

If the `delta` pager is installed, `git diff --no-index | delta --side-by-side` is acceptable.

## Step 2: Attempt a Three-Way Merge

Run a git-like three-way merge using Base, Local, and Remote:

```bash
git merge-file -p \
  -L "LOCAL: user Markdown" \
  -L "BASE: pulled Confluence version" \
  -L "REMOTE: current Confluence version" \
  confluence-edits/<page-id>-<title-slug>.md \
  confluence-edits/.snapshots/<page-id>.base.md \
  confluence-edits/.snapshots/<page-id>.remote.md \
  > confluence-edits/.snapshots/<page-id>.merged.md
```

Interpret exit codes:

| Exit code | Meaning | Action |
|-----------|---------|--------|
| `0` | Merge completed without textual conflicts | Show the merged diff and ask user approval before upload |
| `1` | Conflict markers were produced | Ask user to edit the merged file manually |
| Other | Merge command failed | Report the command error and do not upload |

## Step 3: No Textual Conflicts

If the merge succeeds without conflict markers:

1. Show Base → Local and Base → Remote summaries.
2. Show Remote → Merged so the user sees the final upload delta.
3. Ask: `Загрузить merged-версию обратно в Confluence?`
4. Upload only after the user approves.

## Step 4: Conflict Markers Present

If the merged file contains conflict markers:

```text
<<<<<<< LOCAL: user Markdown
local content
||||||| BASE: pulled Confluence version
base content
=======
remote content
>>>>>>> REMOTE: current Confluence version
```

Tell the user:

```markdown
Статья изменилась в Confluence, пока вы редактировали локальную копию.

Я подготовил файл с конфликтами:
`confluence-edits/.snapshots/<page-id>.merged.md`

Пожалуйста, отредактируйте этот файл: удалите conflict markers и оставьте итоговый Markdown.
Когда закончите, сообщите агенту любыми словами, что редактирование завершено.
```

Do not upload while any of these markers remain:

- `<<<<<<<`
- `|||||||`
- `=======`
- `>>>>>>>`

## Step 5: Upload Resolved Merge

After the user edits the merged file and says in natural language that editing is finished:

1. Re-read the merged file.
2. Verify no conflict markers remain.
3. Fetch the remote page again.
4. If the remote page changed again after `.remote.md` was saved, repeat this conflict workflow using the latest remote content.
5. If the remote page did not change again, upload the merged Markdown.
6. Report the uploaded page ID, title, and resulting version.

## Required User-Facing Summary

When conflicts are detected, include:

- Local file path.
- Remote version at pull time.
- Current remote version.
- Base → Local summary.
- Base → Remote summary.
- Merge file path.
- Exact next instruction: edit the merge file and tell the agent when editing is finished.

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Uploading local over newer remote content | Overwrites another user's work | Use three-way merge first |
| Hiding non-conflicting remote edits | User loses context | Show Base → Remote even when merge is clean |
| Treating `git merge-file` success as final approval | Semantic conflicts can still exist | Ask user to approve merged content |
| Resolving conflict markers yourself without user intent | The correct wording is product/domain-specific | Ask the user to edit the merged file |
