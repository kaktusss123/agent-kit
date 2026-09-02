---
name: lazy-mr-review
description: "Review GitLab merge requests from URLs and report findings in chat; publish comments to the MR only after the user explicitly chooses what to publish. Use when the user shares one or more GitLab MR links and asks to review them, asks follow-up questions about a completed review (re-verify proofs, answer MR authors), or asks to publish review findings as MR comments. Uses glab, exact-SHA checkouts, evidence-backed findings with runtime proofs, and the GitLab discussions API. Creating or updating the MRs themselves is handled by skill://change-request."
---

# Lazy MR review

Review GitLab MRs end-to-end: gather context, verify findings by execution, report in chat — then, only if the user explicitly chooses, publish findings as MR comments.

## Hard rules

- **Chat first.** Findings are reported in chat before anything touches the MR. Publication without a completed review in this conversation is impossible: a "publish" request arriving before any review triggers the full review first, then the publication question.
- **URL is the source of truth.** Take host, project path, and iid from the MR URL. Pass them explicitly on every glab call. Never let glab infer the host from the current directory or a git remote.
- **Never hunt for repositories.** Do not scan the filesystem for clones. Ask the user for local clone paths; clone into a temp directory only when the user says there are none.
- **Evidence, not vibes.** Every finding names `file:line` at the review SHA, the violated contract, impact, and evidence. Executed proofs name the SHA and script path; label static suspicion as static. Never manufacture findings to look thorough.
- **Failures stay raw.** Preserve the command, exit status, stdout, and stderr of any failed CLI/API call. Never normalize errors into a private taxonomy or invent a diagnosis the tool did not establish.
- **Read-only except publication.** No commits, pushes, approvals, branch changes, or code edits. The only MR mutation this skill performs is adding comments.

## Workflow

### 1. Intake

1. Parse each MR URL into `host`, `group/project`, `iid`.
2. Group related MRs: same ticket key in branch or title (`[A-Z]+-\d+`), same author, coupled contract (shared library bump, producer/consumer proto or DTO). Related MRs are reviewed together, including cross-MR contract checks.
3. If a non-GitLab URL appears (GitHub PR), say this skill covers GitLab only and stop.
4. Extract a ticket key if present. When Jira tools are available, fetch summary/description/comments for intent. A missing or empty description is common: state that the contract was inferred from code and name the sources (title, proto annotations, DTOs, callers).
5. This skill does not create or update MRs; route those operations to `skill://change-request`.

### 2. Preflight

1. `command -v glab`.
2. `glab auth status --hostname <host>` — note `-h` means help; always use the long flag.
3. On failure: show raw output and stop. Never log in automatically.

### 3. Snapshot

For each MR record:

- title, state, author, source/target branch, description;
- `diff_refs` (`base_sha`, `start_sha`, `head_sha`) via `glab api "projects/<url-encoded-project>/merge_requests/<iid>" --hostname <host>`;
- the full diff, saved to `<temp_root>/diffs/<project>-<iid>.diff`;
- pipeline status (`glab ci list -R <host>/<project> --ref <source-branch>`);
- existing discussions (ids + file/line) — used for dedup and to avoid re-finding what is already discussed.

The review is tied to `head_sha`. Fetch the diff through `glab mr diff <iid> -R <host>/<project>`.

### 4. Local code

Ask the user (one question covering all repos): local clone path per repository, or "no local copies". Never guess paths from directory layout.

**Provided clone** — validate before use:

1. directory exists and is a git work tree;
2. a remote's project path matches the MR project (normalize: strip scheme, user, trailing `.git`; compare host + path). On mismatch, do not use silently — report and ask;
3. `git fetch <remote> refs/merge-requests/<iid>/head`, then `git rev-parse FETCH_HEAD` must equal `head_sha`;
4. create a detached worktree outside the user's repo: `git worktree add --detach <temp_root>/worktrees/<project> <head_sha>`.

**No clone** — create one:

1. temp root `/tmp/lazy-mr-review-<session-id>/`, subdirs `repos/<project>/`, `diffs/`, `proofs/`;
2. `git clone <url> <temp_root>/repos/<project>` (needs GitLab auth to work — the preflight already covered it);
3. `git fetch origin refs/merge-requests/<iid>/head`, then `git checkout --detach <head_sha>` directly in this clone. No worktree: a temp clone has no state to protect.

Either way verify: `git -C <checkout> rev-parse HEAD` equals `head_sha`, else stop. Never check out inside the user's own working tree.

Record every path in the snapshot (`snapshot.json` in temp root). Temp clones and worktrees persist for the whole conversation (see Cleanup).

### 5. Review

- Read the complete changed files at the review SHA plus their surrounding context — not just diff hunks. Diff-only reading misses shape mismatches between producer and consumer.
- Trace the changed contract end to end: request DTO → proto → service/mapper → persistence shape → response mapping. For stored data, ask what shape already-written rows have; changed read-path conditions can break existing rows.
- Find callers and tests of changed functions. CI green plus missing tests for the changed paths means the code is unproven — say so once, plainly.
- Lenses: `skill://code-review` always. `skill://security-review` when the change touches inputs, auth, secrets, persistence, or network boundaries. `skill://blast-radius` or `skill://system-understanding` for cross-service or lifecycle risk. Use the OpenCode `reviewer` agent only when an independent fresh-context pass is useful and provide it the exact SHA, checkout, and review context.
- For related MRs: check contract symmetry both ways — version bumps of shared libs, optional/required field drift between producer and consumer, semantic domains of identifiers passed between services.
- Severity: `blocker` (breaks a main path, contract, or existing data), `major` (realistic edge breaks, wrong error contract), `minor` (maintainability), `suggestion`.

### 6. Proofs

For every claimed regression or breakage, prove it by execution when reachable:

1. Minimal script in `<temp_root>/proofs/`, never inside the checkout. The script's own directory must not contain modules shadowing stdlib names (a stray `types.py` once broke a run).
2. Run against the checkout: `cwd` = checkout, `sys.path` prepends the checkout, prefer the repo's `.venv/bin/python` when present.
3. Before judging results, print and assert the imported module's `__file__` resolves inside the checkout. Installed venv packages can differ from MR deps and will produce plausible-looking wrong answers.
4. Environment: values from `.env.example` or dummy variables for required settings. Never copy the user's real `.env`.
5. When claiming a regression, also run the old shape/old behavior as a control and show it worked.
6. Record per proof: script path, log path, SHA. Keep logs next to scripts.

### 7. Report in chat

In the user's language, structured:

```text
Verdict
Blocking findings      (blocker severity)
Non-blocking findings  (major / minor / suggestion)
Security notes
Evidence               (what was executed, on which SHA, script paths)
Open questions for the author
```

Each finding: `file:line` at `head_sha`, observed behavior, violated contract, impact, evidence, smallest fix direction.

### 8. Publication gate

End the report with exactly one question: publish blockers only (recommended) / publish all findings / publish nothing.

- "Nothing" — stop; the MR stays untouched.
- If the user explicitly pre-announced the scope ("отревьюй и запости блокеры"), present the findings first, then publish the pre-announced scope without re-asking. If scope is ambiguous, ask.
- Publishing without a completed review is impossible. If the user opens with "publish", run sections 1–7 first.

### 9. Publication

Follow `references/publication.md` for exact payloads and verification. Outline:

1. Re-fetch MR metadata; compare `head_sha`. If it moved: recompute the diff mapping, re-verify each affected finding, publish only surviving findings with fresh positions, and tell the user what changed. Never post positions from an old SHA.
2. Deduplicate against existing discussions (file+line, body prefix); skip covered findings and say so.
3. For each finding: inline discussion when the line is representable in the current diff, otherwise a summary note (see the unchanged-line rule in the reference: `old_line` and `new_line`).
4. Post a summary note per MR scoped to what was actually published: verdict, list of published findings, open questions.
5. Verify every response: discussion id and non-null `position` for inline comments. A zero exit code alone proves nothing.
6. Related MRs are published each to its own project/iid with its own `diff_refs`.
7. Report created discussion ids/URLs and any fallbacks or skipped findings.

### 10. Cleanup

- Keep temp clones, worktrees, diffs, and proofs for the whole conversation: MR authors reply to comments and proofs may need re-running.
- Delete only on explicit user request or explicit end of the workflow.
- A new review round on the same repo reuses the existing clone: `git fetch` + fresh `checkout --detach` at the new SHA; do not re-clone.
- `/tmp` may not survive a reboot. If the user wants durable artifacts, let them name a persistent directory at intake.

## Pitfalls

- `glab api` without `--hostname` picks the wrong default host (`Unauthenticated` or 404 against the right-looking command).
- `glab mr view|diff|note` do not accept `--hostname`; use `-R <host>/<group>/<project>`.
- `glab auth status -h <host>` prints help — `-h` is the help flag; use `--hostname`.
- Bracket form fields (`-f "position[base_sha]=..."`) are flattened to top-level JSON keys; GitLab silently creates an unanchored note with exit 0. Always POST a nested JSON body via `--input`.
- Exit 0 on a discussions POST does not mean the comment is anchored. Check `notes[0].position` in the response.
- A `400 ... line_code ... must be a valid line code` means the line is not representable in the current diff — fall back to a summary note.
- A proof run against an installed package instead of the checkout produces confident nonsense. Always assert `module.__file__`.
