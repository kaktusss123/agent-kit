# Publication reference — GitLab discussions via glab

Publication happens only after a completed review and an explicit user choice of scope.

## Endpoint and command shape

```sh
glab api "projects/<url-encoded-project>/merge_requests/<iid>/discussions" \
  --hostname <host> \
  --method POST \
  --header "Content-Type: application/json" \
  --input payload.json
```

- `<url-encoded-project>`: `group/sub/project` → `group%2Fsub%2Fproject`.
- The body must be a **nested JSON file**. Do not pass `position` through `-f` flags: glab flattens bracket keys (`position[base_sha]`) into top-level JSON keys, GitLab ignores them, and the note is created **unanchored with exit 0**.

## Inline comment payload

```json
{
  "body": "markdown text",
  "position": {
    "base_sha":  "<diff_refs.base_sha>",
    "start_sha": "<diff_refs.start_sha>",
    "head_sha":  "<diff_refs.head_sha>",
    "position_type": "text",
    "old_path": "path/in/repo.py",
    "new_path": "path/in/repo.py",
    "new_line": 236
  }
}
```

`base_sha`, `start_sha`, `head_sha` come from the MR's `diff_refs`, fetched fresh at publication time — never from a stale snapshot when the head moved.

`old_path` and `new_path` are both required. For renamed files use the old path in `old_path` and the new path in `new_path`.

## Choosing line fields

Parse the saved diff's hunk headers (`@@ -a,b +c,d @@`) to build the old↔new line mapping for the current diff.

| Line kind | `position` fields |
|---|---|
| added line | `new_line` only |
| removed line | `old_line` only |
| unchanged context line | `old_line` **and** `new_line` — numbers may differ if earlier hunks shifted lines; take both sides from the mapping, do not assume equal |

A line the current diff does not represent yields `400 Bad request - Note {:line_code=>["can't be blank", "must be a valid line code"]}`. Treat that as "fall back to a summary note", not "skip the finding".

## Summary note

Same POST, payload without `position`:

```json
{
  "body": "## Review verdict\n..."
}
```

Used for: the MR-level verdict, findings on lines not representable in the diff, and cross-file/cross-MR observations.

## Verify every POST

A zero exit code only means the HTTP call succeeded. After each POST check the response:

```sh
jq -r '"\(.id) anchored=\(.notes[0].position != null) line=\(.notes[0].position.new_line // .notes[0].position.old_line // "none")"' resp.json
```

If an inline comment came back with `anchored=false`, it landed as an unanchored note. Delete it and fall back to a summary note (or fix the position and retry):

```sh
glab api "projects/<enc>/merge_requests/<iid>/notes/<note_id>" \
  --hostname <host> --method DELETE
```

The discussion-level `DELETE .../discussions/<id>` may return 404; delete the note instead.

## Deduplicate before posting

```sh
glab api "projects/<enc>/merge_requests/<iid>/discussions?per_page=100" --hostname <host>
```

Index existing notes by (file, line) and by body opening line. Skip findings already covered by existing comments and report the skips. This also avoids re-reporting what is already being discussed with the author.

## Multi-MR sets

Each MR is published to its own project, iid, and `diff_refs`. Never reuse positions or SHAs across MRs, even for identical text.

## Comment content

- Lead with the severity tag (`BLOCKER` / `MAJOR` / `MINOR` / `SUGGESTION`) and a concrete defect.
- Keep the visible body short: explain the defect, its consequence, and the fix direction in 2-4 sentences. A simple `MINOR` or `SUGGESTION` may be a single sentence. Never expand a simple finding just to satisfy a template.
- Do not put investigation history, control experiments, full payloads, stack traces, or step-by-step reproduction in the visible body.
- For a non-obvious finding, add a collapsed proof only when it materially helps the author verify the claim:

```md
<details>
<summary>Proof</summary>

Verified on `<sha>`. Minimal author-runnable trigger and observed result.

</details>
```

- The proof is optional, not a required block for any severity. Prefer no proof section when the causal mismatch is obvious from the referenced code.
- A published finding must still stand on its own. Never include `/tmp`, `artifact://`, `local://`, checkout-specific paths, or `proofs/...` script/log references. Local proof paths and logs are internal chat evidence only.
- If evidence is included, use only what was actually executed or observed and express it in terms the MR author can reproduce from repository inputs or commands. Never fabricate test results, links, ticket ids, or commands.
- The MR-level summary is an index, not a duplicate review: state the verdict and list each published finding in one line. Do not repeat inline explanations.
- Before each POST, scan the public payload. Reject and rewrite any body containing `/tmp`, `artifact://`, `local://`, absolute checkout paths, or `proofs/...`.
