---
name: git-commit
description: Git commit workflow for generating conventional messages, respecting branch safety, and using the GitCommitter subagent when a user explicitly asks for a commit
---

# Git Commit Skill

## Purpose

Use this skill when the user explicitly asks to create a git commit or asks how commits should be created in this workspace.

Primary agents should offload commit execution quickly instead of spending their own context window on commit analysis.

## Commit Policy

- Create commits only after explicit user intent.
- Never commit on `main`, `master`, or `develop`.
- Never push as part of the commit workflow.
- Always keep commit messages in English.
- Always run hooks; never use `--no-verify`.
- Retry once if hooks modify files.

## Message Format

- Format: `<type>(EVODP-XXXX): <description>`
- Prefer `feat`, `fix`, or `chore` from the branch prefix.
- Extract `EVODP-<number>` from the branch name when present.
- Keep the full message short, ideally within 20 words.
- Use imperative mood.

## Execution Flow

1. Check the current branch.
2. Inspect staged and unstaged changes.
3. Stage relevant files when needed.
4. Draft the message from the branch name and diff.
5. Delegate the actual commit to `GitCommitter` when available.
6. Return a short status report with branch, message, commit hash, and notes.

## Preferred Routing

- For actual commit creation, use the `GitCommitter` subagent.
- The `/commit` command is only one entry point; the same rules apply when a core agent handles a commit request directly.
- A parent agent may pass a short summary of completed work, but `GitCommitter` still inspects the repository and derives the final commit details itself.
