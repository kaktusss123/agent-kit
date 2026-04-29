---
name: git-commit
description: Git commit workflow for generating conventional messages, respecting branch safety, and using the committer subagent when a user explicitly asks for a commit
---

# Git Commit Skill

## Purpose

Use this skill when the user explicitly asks to create a git commit or asks how commits should be created in this workspace.

Primary agents should offload commit execution quickly instead of spending their own context window on commit analysis.

## Triggers

| If the user says… | Then… |
|---|---|
| `commit these changes` | Run the commit workflow |
| `create a git commit` | Run the commit workflow |
| `stage and commit` | Run the commit workflow |
| `make a commit` | Run the commit workflow |

## Quick Reference

| Input | Output | Duration |
|---|---|---|
| Staged/unstaged changes | Git commit on current branch | Short (<30s) |

## Commit Policy

- Create commits only after explicit user intent
- NEVER commit on `main`, `master`, or `develop` branches
- NEVER push to remote as part of the commit workflow
- ALWAYS keep commit messages in English
- ALWAYS run pre-commit hooks (never use `--no-verify`)
- NEVER use `git add .` or other blanket staging commands
- NEVER stage files that likely contain secrets (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`)
- ALWAYS require a valid `EVODP-<number>` ticket in the branch name
- Retry once if hooks modify files

## Message Format

**Format**: `<type>(EVODP-1234): <description>`

### Type Selection

1. Prefer branch prefix: `fix/` → `fix`, `feat/` → `feat`, `chore/` → `chore`
2. Default to `chore` if unknown
3. Use `fix` for bug fixes and corrections
4. Use `feat` for new features and functionality
5. Use `chore` for maintenance, refactoring, documentation, and other non-feature changes

### Ticket Extraction

- Extract `EVODP-<number>` from branch name when present
- If missing, stop and return status `missing_ticket`

### Description Rules

- Write in English ONLY
- Use imperative mood (e.g., "add", "fix", "update", not "added", "fixed", "updated")
- Focus on WHAT was changed, not HOW
- Keep it concise and meaningful
- Maximum 20 words total for entire commit message

## Detailed Workflow

1. **Check current branch**:
   - Run `git rev-parse --abbrev-ref HEAD`
   - If branch is `main`, `master`, or `develop`, return status `blocked_branch`

2. **Inspect changes**:
   - Run `git status --porcelain`
   - If no changes, return status `no_changes`

3. **Stage changes**:
   - Check staged changes: `git diff --cached --name-only`
   - If staged files exist, keep the current staged set
   - If empty, inspect `git status --porcelain` and build an explicit candidate file list
   - Exclude likely secret files such as `.env`, `.env.*`, `*.pem`, `*.key`, and `credentials.json`
   - Stage only explicit file paths with `git add -- <path>...`

4. **Build commit message**:
   - Extract type from branch prefix
   - Extract ticket number from branch name
   - If ticket number is missing, stop and return status `missing_ticket`
   - Use provided description from arguments OR derive from `git diff --cached --stat`
   - Assemble: `<type>(EVODP-1234): <description>`

5. **Create commit**:
   - Run `git commit -m "<message>"` (do NOT use `--no-verify`)
   - If it fails:
     - Capture the error output
     - If hooks modified already selected files, re-stage only that file set and retry ONCE with the same message
     - If it still fails, return status `failed`

6. **Report**: Return a concise report in this exact structure:

   ```text
   status: <success|failed|blocked_branch|no_changes|missing_ticket>
   branch: <branch>
   message: <commit message or n/a>
   commit: <short hash or n/a>
   staged_files: <N>
   notes: <one line, optional>
   ```

## Examples

### Good commit messages

```text
fix(EVODP-5407): resolve casbin policy validation error
feat(EVODP-5407): add trino user authentication
chore(EVODP-5407): update dependencies and clean code
```

### Bad commit messages

```text
Fixed the issue with casbin policies not working correctly in trino authentication module
(Too long, past tense)

feat: add new feature
(Missing ticket number, too vague)

chore(EVODP-XXXX): update docs
(Placeholder ticket is forbidden)

fix(EVODP-5407): Исправил ошибку в коде
(Russian language)
```

## Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| Past-tense message like `Fixed the issue…` | Violates imperative mood rule | `fix(EVODP-5407): resolve casbin policy validation error` |
| Missing ticket in message | No traceability to ticket | `feat(EVODP-9999): add user authentication endpoint` |
| Placeholder ticket `EVODP-XXXX` | Breaks traceability, looks incomplete | Use actual ticket number or omit ticket scope |
| Non-English message | Violates English-only rule | Write description in English |
| `git add .` | Stages unexpected files, may include secrets | Use `git add -- <path>` with explicit paths |
| Commit on `main`/`master`/`develop` | Bypasses review, violates branch policy | Create a feature or fix branch first |
| `git commit --no-verify` | Skips pre-commit hooks, may introduce bugs | Let hooks run and fix any issues they catch |

## Routing

- For actual commit creation, use the `committer` subagent
- The `/commit` command is one entry point; the same rules apply when a core agent handles a commit request directly
- A parent agent may pass a short summary of completed work, but `committer` still inspects the repository and derives the final commit details itself

## Verification

After creating a commit, confirm all of the following:

- [ ] Branch is not `main`, `master`, or `develop` (safe branch)
- [ ] Branch name contains a valid `EVODP-XXXX` ticket
- [ ] Commit message follows `<type>(EVODP-XXXX): <description>` format
- [ ] Pre-commit hooks passed (no `--no-verify` used)
- [ ] No secret files (`.env`, `*.pem`, `*.key`, `credentials.json`) were staged
- [ ] Only expected files are included in the commit
