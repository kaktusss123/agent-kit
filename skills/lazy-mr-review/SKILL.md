---
name: lazy-mr-review
description: "Review GitLab MRs from URLs and report findings in chat; publish comments to the MR only after the user explicitly chooses what to publish. Use when the user shares MR links and asks to review them, asks follow-up questions about a completed review, or asks to publish findings as MR comments. Creating or updating MRs themselves is change-request's job."
---

# Lazy MR review

Review GitLab MRs end-to-end: snapshot, verify findings by execution, report in chat — publish only on the user's explicit choice. Deterministic mechanics (preflight, metadata, diff, checkout at the review SHA, publication payloads, anchoring verification) live in `scripts/review_snapshot.py` and `scripts/publish_comments.py`; run `scripts/selftest.sh` there if the tools misbehave. This file is the judgment layer.

## Hard rules

- **Chat first.** Findings are reported in chat before anything touches the MR. A "publish" request before any review triggers the full review first, then the publication question.
- **Never hunt for repositories.** Ask the user for local clone paths; use `--no-clone` only when they say none exist. Never guess paths from directory layout, never check out inside the user's own working tree.
- **Evidence, not vibes.** Every finding names `file:line` at the review SHA, the violated contract, impact, and evidence. Executed proofs name the SHA, command, and observed result in the chat report. Local proof paths and logs are internal artifacts, never published. Label static suspicion as static; an unverified producer value makes the finding `conditional`, never a standalone blocker. Never manufacture findings to look thorough.
- **Failures stay raw.** The tools print raw command, exit status, stdout, stderr. Pass that through; never normalize into a private taxonomy or invent a diagnosis the CLI did not establish.
- **Read-only except publication.** No commits, pushes, approvals, branch changes, or code edits. The only MR mutation is adding comments.

## Workflow

### 1. Intake

Group related MRs (same ticket key, same author, coupled contract — shared library bump, producer/consumer DTO): they are reviewed together, including cross-MR contract checks. Extract the ticket key; fetch Jira summary/description when tools allow. An empty MR description is common: state that the contract was inferred from code and name the sources. A non-GitLab URL: say this skill covers GitLab only and stop. Creating or updating MRs routes to `skill://change-request`.

### 2. Snapshot

Ask the user (one question covering all repos) for local clone paths or "no local copies". Then run:

```sh
python3 scripts/review_snapshot.py <url>... (--clone <path> | --no-clone) [--temp-root <dir>]
```

The tool performs the glab preflight (auth failure → show raw output and stop, never log in), parses each URL into host/project/iid, records title/state/author/branches/description, `diff_refs`, saves the full diff, pipeline status, and existing discussions (for dedup), and produces a verified detached checkout of `head_sha` outside the user's repo. It refuses a clone whose remotes do not match the MR project — report that to the user and ask. The review is tied to `head_sha`; a re-review reuses the same temp root (fetch + fresh detach, no re-clone). Temp artifacts persist for the whole conversation (see Cleanup).

### 3. Review

- Read the complete changed files at the review SHA plus surrounding context, not just hunks: diff-only reading misses producer/consumer shape mismatches.
- Trace the changed contract end to end: request DTO → proto → service/mapper → persistence shape → response mapping. For stored data, ask what shape already-written rows have; changed read-path conditions can break existing rows.
- Find callers and tests of changed functions. CI green plus missing tests for changed paths means the code is unproven — say so once, plainly.
- Lenses: `skill://code-review` always; `skill://security-review` when inputs, auth, secrets, persistence, or network boundaries are touched; `skill://blast-radius` or `skill://system-understanding` for cross-service or lifecycle risk.
- For related MRs check contract symmetry both ways: version bumps of shared libs, optional/required field drift, semantic domains of identifiers crossing services. A changed cross-repo contract without a verified producer: request only that repository and the relevant ref.
- Severity: `blocker` (main path, public contract, existing data, release, or serious security broken; must fix before merge), `major` (real defect that should be fixed before merge), `minor` (real issue that does not block), `suggestion` (optional improvement).

### 4. Proofs

For every claimed regression or breakage, prove it by execution when reachable:

1. Minimal script in `<temp_root>/proofs/`, never inside the checkout.
2. Run against the checkout: `cwd` = checkout, `sys.path` prepends the checkout, prefer the repo's `.venv/bin/python` when present. Before judging results, print and assert the imported module's `__file__` resolves inside the checkout — installed venv packages produce plausible-looking wrong answers.
3. Environment from `.env.example` or dummy values; never copy the user's real `.env`.
4. When claiming a regression, run the old shape as a control and show it worked. Record per proof: script path, log path, SHA.

### 5. Report in chat

In the user's language, structured:

```text
Verdict
Changes required       (blocker / major)
Non-blocking findings  (minor / suggestion)
Security notes
Evidence               (what was executed, on which SHA, script paths)
Open questions for the author
```

Each finding: `file:line` at `head_sha`, observed behavior, violated contract, impact, evidence, smallest fix direction. Chat is the full review record; published comments are intentionally shorter.

### 6. Publication gate

End the report with exactly one question: publish blockers only (recommended) / publish all findings / publish nothing. "Nothing" stops with the MR untouched. If the user pre-announced the scope ("отревьюй и запости блокеры"), present findings first, then publish the pre-announced scope without re-asking; ambiguous scope → ask.

### 7. Publish

Write the final comment bodies per `references/publication.md` (short, no investigation history, optional collapsed proof, no local paths), then run:

```sh
python3 scripts/publish_comments.py <payload.json>
```

Payload: `url`, `expected_head_sha`, optional `summary_note`, findings with `file`/`new_line`/`old_line` from the saved diff's hunk mapping. The tool re-fetches `diff_refs` fresh, refuses with `head_moved` when the head advanced (then re-verify each affected finding and publish only survivors at fresh positions), dedups against existing discussions, POSTs nested JSON, verifies each comment is anchored, and falls back to a summary note when a line is not representable or a note lands unanchored. Never hand-roll `glab` publication: the bracket-form and anchoring traps are why the tool exists. Report created discussion ids and any skips or fallbacks; related MRs are published one payload per project/iid.

### 8. Cleanup

Keep temp clones, worktrees, diffs, and proofs for the whole conversation: authors reply to comments and proofs may need re-running. Delete only on explicit user request or end of the workflow. `/tmp` may not survive a reboot; if the user wants durable artifacts, let them name a persistent directory at intake.
