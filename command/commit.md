---
description: Create well-formatted commits with conventional commit messages and run pre-commit hooks
agent: GitCommitter
model: xai/grok-4-1-fast
---

# Commit Command

Create exactly one git commit in the current repository.

## Inputs

- `$ARGUMENTS` - Optional short description for the commit message

## Requirements

1. **Check current branch**: Use `git rev-parse --abbrev-ref HEAD`. If branch is `main`, `master`, or `develop`, return status `blocked_branch`.

2. **Inspect changes**: Use `git status --porcelain`. If no changes, return status `no_changes`.

3. **Stage changes**: If no staged changes (`git diff --cached --name-only` is empty), run `git add .`.

4. **Build commit message**:
   - **Type**: Prefer branch prefix - `fix/` → `fix`, `feat/` → `feat`, `chore/` → `chore`. Default to `chore` if unknown.
   - **Ticket**: Extract `EVODP-<number>` from branch name. If missing, use `EVODP-XXXX` and add a warning.
   - **Description**: If `$ARGUMENTS` is non-empty, use it. Otherwise derive a short English imperative description from `git diff --cached --stat`.
   - **Format**: `<type>(EVODP-XXXX): <description>`
   - **Constraints**: Description MUST be English. Entire message SHOULD be <= 20 words.

5. **Commit message guidelines**:
   - Use `fix` for bug fixes and corrections
   - Use `feat` for new features and functionality
   - Use `chore` for maintenance, refactoring, documentation, and other non-feature changes
   - Write in English ONLY
   - Keep it concise and meaningful
   - Maximum 20 words total for entire commit message
   - Focus on WHAT was changed, not HOW
   - Use imperative mood (e.g., "add", "fix", "update", not "added", "fixed", "updated")

6. **Create commit**: Run `git commit -m "<message>"` (do NOT use `--no-verify`). If it fails:
   - Capture the error output
   - If hooks modified files, run `git add .` and retry ONCE with the same message
   - If it still fails, return status `failed`

7. **Report**: Return a concise report in this exact structure:
   ```
   status: <success|failed|blocked_branch|no_changes>
   branch: <branch>
   message: <commit message or n/a>
   commit: <short hash or n/a>
   staged_files: <N>
   notes: <one line, optional>
   ```

## Examples

### Good commit messages
```
fix(EVODP-5407): resolve casbin policy validation error
feat(EVODP-5407): add trino user authentication
chore(EVODP-5407): update dependencies and clean code
```

### Bad commit messages
```
❌ Fixed the issue with casbin policies not working correctly in trino authentication module
❌ feat: add new feature
❌ fix(EVODP-5407): Исправил ошибку в коде (Russian language)
```
