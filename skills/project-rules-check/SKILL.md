---
name: project-rules-check
description: "Verifies documented commands, checks freshness metadata, and reports stale or broken references in project AGENTS.md"
---

# Project Rules Check

Use this skill after implementation or on demand to verify the accuracy of a project's AGENTS.md.

## Triggers

| If the user says... | Then... |
|---|---|
| `project-rules-check: {goal}` | Run the verification workflow |
| `check project rules` | Run the verification workflow |
| `/init --check` | Run the verification workflow in check mode |

## Quick Reference

| Input | Output | Duration |
|---|---|---|
| Target project root | Verification report with freshness status | Short to medium |

## Modes

| Mode | Behavior |
|---|---|
| `check` | Full verification: commands, freshness, stale references |
| `freshness-only` | Check only freshness metadata and git history comparison |

## Process

### Phase 1: Resolve Target and Read Metadata

1. **Resolve target root** — Determine the target project root from the current directory or explicit argument.
2. **Read AGENTS.md** — Load the existing project AGENTS.md if present.
3. **Read freshness metadata** — Load `<target>/.opencode/agents-freshness.json` if present.

**Verification:** Target root is resolved before any checks. Missing files are noted, not treated as errors.

### Phase 2: Verify Documented Commands

1. **Extract commands** — Parse the Commands section from AGENTS.md.
2. **Existence checks** — For each command, verify the referenced files or scripts exist using non-destructive checks (`test -f`, `test -d`, `command -v`).
3. **Mark status** — Commands referencing missing files or paths are marked as `broken`.
4. **Local-only** — All checks are local; do NOT run `git fetch`, `git pull`, `git push`, `git clone`, `gh`, SSH, cloud CLIs, or package-manager network operations.

**Verification:** Every command is checked with a non-destructive existence check. No destructive commands are executed.

### Phase 3: Check Freshness

1. **Compare timestamps** — If freshness metadata exists, compare `lastVerified` date against git history for tracked files modified after that date.
2. **Git history check** — Use `git log --since=<date> --name-only --pretty=format:` to find files changed since last verification.
3. **Cross-reference** — Compare changed files against documented paths and commands in AGENTS.md.
4. **Non-git fallback** — If the target is not a git repository, skip git freshness checks and warn.

**Verification:** Freshness check uses only local git commands. No remote git operations are performed.

### Phase 4: Detect Stale References

1. **File/path references** — Check documented file paths and directories against actual filesystem.
2. **Command references** — Verify referenced scripts, binaries, and entry points still exist.
3. **Report stale items** — List any references that no longer resolve.

**Verification:** All checks are read-only and non-destructive.

### Phase 5: Report

Return a structured report:

```text
status: fresh | update_recommended | blocked | manual_review_needed
target_root: <path>
freshness_status: fresh | stale | never_verified | missing_metadata | corrupt_metadata
commands_checked: <count>
commands_broken: <count>
stale_references: <list or none>
recommendation: <action or n/a>
warnings: <list or none>
```

## Anti-Patterns

| Avoid | Why | Instead |
|---|---|---|
| Running remote git or network commands | Violates local-only constraint | Use only local file and git inspection |
| Executing documented commands | May be destructive | Use existence checks only (`test -f`, `command -v`) |
| Failing on missing metadata | Metadata may never have been written | Treat as `never_verified` and recommend update |
| Crashing on corrupt metadata | Corrupt JSON should not break workflow | Warn, ignore corrupt data, and report |

## Verification

After execution:

- [ ] Target root is resolved
- [ ] All documented commands are checked with non-destructive existence checks
- [ ] Freshness metadata is compared against local git history (or skipped with warning for non-git)
- [ ] Stale references are identified and reported
- [ ] No remote git, network, or destructive commands were executed
- [ ] Output is safe and contains no secret values
