#!/usr/bin/env python3
"""Publish review findings as GitLab MR discussions (glab) or GitHub PR
review comments (gh).

Does the deterministic half of publication: fresh head check, head-moved
refusal, dedup against existing comments, POSTs with request bodies from
temp files, anchoring verification, and fallback to a summary-level comment.
Prints a structured JSON result to stdout.

Usage:
    publish_comments.py PAYLOAD.json

Payload:
    {
      "url": "https://gitlab.test/<group>/<project>/-/merge_requests/<iid>"
           | "https://github.com/<owner>/<repo>/pull/<number>",
      "expected_head_sha": "<sha the review was made against>",
      "summary_note": {"body": "markdown"},          // optional, change-level
      "findings": [
        {
          "id": "F1",
          "body": "markdown",                        // final, publishable text
          "file": "path/in/repo.py",                 // for inline comments
          "old_file": "old/path.py",                 // optional, renamed files
          "new_line": 23,                            // added/context lines
          "old_line": 240                            // removed/context lines
        }
      ]
    }

A finding with no file/line fields posts as a summary note (GitLab MR note /
GitHub review body). Context lines need both old_line and new_line taken from
the diff's hunk mapping.

GitLab: one discussion per finding; an API error naming an invalid line_code
falls back to an MR-level note.

GitHub: one COMMENT review per finding (comments[] carries path/side/line);
summary-level posts go to the issue comments. A 422 validation failure on
the review POST (line not part of the current diff) falls back to an issue
comment. Submitted reviews cannot be deleted, so the unanchored-note delete
path is GitLab-only; a GitHub comment either anchors or 422s.

Exit codes: 0 published (skips and fallbacks are in the result), 1 raw CLI
failure, 2 usage error, 3 head moved (result.status=head_moved, nothing
posted), 4 payload hygiene rejection (bodies contain /tmp, artifact://,
local://, or proofs/ references).
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

URL_RE = re.compile(r"^https?://([^/]+)/(.+?)/-/merge_requests/(\d+)/?$")
GH_URL_RE = re.compile(r"^https?://([^/]+)/([^/]+/[^/]+)/pull/(\d+)/?$")
FORBIDDEN = ["/tmp", "artifact://", "local://", "proofs/"]
LINE_CODE_400 = re.compile(r"line_code|must be a valid line code", re.I)


def emit(obj, code=0):
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def fail_raw(cmd, proc):
    print(
        f"publish_comments: command failed\n"
        f"  command: {' '.join(cmd)}\n"
        f"  exit: {proc.returncode}\n"
        f"  stdout:\n{proc.stdout}\n"
        f"  stderr:\n{proc.stderr}",
        file=sys.stderr,
    )
    emit({"status": "failed"}, code=1)


def run(cmd):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        print(f"publish_comments: command not found: {cmd[0]}", file=sys.stderr)
        emit({"status": "failed"}, code=1)
    if proc.returncode != 0:
        fail_raw(cmd, proc)
    return proc.stdout


def glab_raw(*args):
    """Run glab, returning (proc) without failing on non-zero exit."""
    return subprocess.run(["glab", *args], capture_output=True, text=True)


def glab(*args):
    proc = glab_raw(*args)
    if proc.returncode != 0:
        fail_raw(["glab", *args], proc)
    return proc.stdout


def gh_raw(*args, host=None):
    import os
    env = dict(os.environ)
    if host is not None:
        env["GH_HOST"] = host
    return subprocess.run(["gh", *args], capture_output=True, text=True, env=env)


def gh(*args, host=None):
    proc = gh_raw(*args, host=host)
    if proc.returncode != 0:
        fail_raw(["gh", *args], proc)
    return proc.stdout


def parse_url(url):
    m = URL_RE.match(url.strip())
    if m:
        return {"backend": "gitlab", "host": m.group(1), "project": m.group(2), "iid": m.group(3)}
    m = GH_URL_RE.match(url.strip())
    if m:
        return {"backend": "github", "host": m.group(1), "project": m.group(2), "iid": m.group(3)}
    print(f"publish_comments: not a GitLab MR or GitHub PR URL: {url}", file=sys.stderr)
    sys.exit(2)


def enc(project):
    return project.replace("/", "%2F")


class GhHttpError(Exception):
    """gh api returned a non-2xx HTTP status; carries (status, raw text)."""

    def __init__(self, status, text):
        super().__init__(f"HTTP {status}: {text}")
        self.status = status
        self.text = text


def gh_api(method, path, obj, host):
    """gh api with a JSON request body. Returns parsed JSON ({} when empty).
    Raises GhHttpError(status, text) on an HTTP error so callers can classify
    (422 validation vs transport failure) instead of guessing from stderr."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(obj, f, ensure_ascii=False)
        pfile = f.name
    proc = gh_raw("api", "--method", method, "--input", pfile, path, host=host)
    Path(pfile).unlink(missing_ok=True)
    if proc.returncode != 0:
        text = ((proc.stdout or "") + (proc.stderr or "")).strip()
        m = re.search(r"HTTP (\d{3})", text)
        if not m:
            m = re.search(r'"status":"(\d{3})"', text)
        status = int(m.group(1)) if m else 0
        raise GhHttpError(status, text[:400])
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


def gh_comment_side_line(finding):
    """GitHub anchoring: RIGHT/new_line for added/context, LEFT/old_line for
    removed lines. Returns {} for a summary-level finding."""
    if finding.get("new_line") is not None:
        return {"side": "RIGHT", "line": finding["new_line"]}
    if finding.get("old_line") is not None:
        return {"side": "LEFT", "line": finding["old_line"]}
    return {}


def gh_publish(host, project, iid, payload, findings):
    # Fresh head; never post comments against an old diff.
    meta = json.loads(gh("pr", "view", iid, "--repo", project, "--json", "headRefOid", host=host))
    if meta.get("headRefOid") != payload["expected_head_sha"]:
        emit({
            "status": "head_moved",
            "expected": payload["expected_head_sha"],
            "actual": meta.get("headRefOid"),
        }, code=3)

    covered_pairs, covered_first_lines = set(), set()
    for c in (json.loads(gh("api", f"repos/{project}/pulls/{iid}/comments?per_page=100", host=host)) or []):
        covered_pairs.add((c.get("path"), c.get("line")))
        body = (c.get("body") or "").strip()
        if body:
            covered_first_lines.add(body.splitlines()[0][:120])
    for c in (json.loads(gh("api", f"repos/{project}/issues/{iid}/comments?per_page=100", host=host)) or []):
        body = (c.get("body") or "").strip()
        if body:
            covered_first_lines.add(body.splitlines()[0][:120])

    def post_issue_comment(body):
        resp = gh_api("POST", f"repos/{project}/issues/{iid}/comments", {"body": body}, host)
        return resp.get("id")

    result = {"status": "published", "published": [], "skipped": [], "fallbacks": []}
    for f in findings:
        body = f.get("body") or ""
        body_first = body.strip().splitlines()[0][:120] if body.strip() else ""
        anchor = gh_comment_side_line(f) if f.get("file") else {}
        pair = (f.get("file"), anchor.get("line"))
        if anchor and pair in covered_pairs:
            result["skipped"].append({"id": f.get("id"), "reason": "existing comment on file+line"})
            continue
        if body_first and body_first in covered_first_lines:
            result["skipped"].append({"id": f.get("id"), "reason": "existing comment with same opening line"})
            continue

        if not anchor:
            # Summary-level finding: issue comment (the PR timeline).
            cid = post_issue_comment(body)
            result["published"].append({"id": f.get("id"), "comment_id": cid, "mode": "summary", "anchored": False})
            continue

        review = {
            "event": "COMMENT",
            "comments": [{"path": f["file"], "body": body, **anchor}],
        }
        try:
            resp = gh_api("POST", f"repos/{project}/pulls/{iid}/reviews", review, host)
        except GhHttpError as e:
            if e.status == 422:
                # Line not representable in the current diff -> issue comment.
                cid = post_issue_comment(body)
                result["fallbacks"].append({
                    "id": f.get("id"), "to": "summary",
                    "reason": f"line not representable: {e.text[:200]}", "comment_id": cid,
                })
                result["published"].append({"id": f.get("id"), "comment_id": cid, "mode": "fallback-summary", "anchored": False})
                continue
            print(
                f"publish_comments: command failed\n  command: gh api POST .../reviews\n  http: {e.status}\n  output:\n{e.text}",
                file=sys.stderr,
            )
            emit({"status": "failed"}, code=1)

        review_id = resp.get("id")
        # Anchoring verification: the created review's comments must carry
        # path+line. (A submitted review cannot be deleted — no GitLab-style
        # unanchored rollback; a bad line 422s before creation instead.)
        anchored, line_out = False, None
        for c in (json.loads(gh("api", f"repos/{project}/pulls/{iid}/reviews/{review_id}/comments", host=host)) or []):
            if c.get("path") == f.get("file"):
                anchored = c.get("line") is not None
                line_out = c.get("line")
        result["published"].append({
            "id": f.get("id"), "review_id": review_id,
            "mode": "inline", "anchored": anchored, "line": line_out,
        })

    if payload.get("summary_note"):
        cid = post_issue_comment(payload["summary_note"]["body"])
        result["summary_comment_id"] = cid
    emit(result)


def hygiene(payload):
    bad = []
    for item in ([payload.get("summary_note")] if payload.get("summary_note") else []) + payload.get("findings", []):
        body = item.get("body", "")
        hits = [tok for tok in FORBIDDEN if tok in body]
        if hits:
            bad.append({"id": item.get("id", "summary_note"), "hits": hits})
    return bad


def post_discussion(host, project, iid, payload_obj):
    """POST one discussion payload; returns (proc, payload file kept for debugging)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload_obj, f, ensure_ascii=False)
        path = f.name
    proc = glab_raw(
        "api", f"projects/{enc(project)}/merge_requests/{iid}/discussions",
        "--hostname", host, "--method", "POST",
        "--header", "Content-Type: application/json", "--input", path,
    )
    Path(path).unlink(missing_ok=True)
    return proc


def position_for(finding, diff_refs):
    pos = {
        "base_sha": diff_refs["base_sha"],
        "start_sha": diff_refs["start_sha"],
        "head_sha": diff_refs["head_sha"],
        "position_type": "text",
        "old_path": finding.get("old_file") or finding["file"],
        "new_path": finding["file"],
    }
    if finding.get("new_line") is not None:
        pos["new_line"] = finding["new_line"]
    if finding.get("old_line") is not None:
        pos["old_line"] = finding["old_line"]
    return pos


def note_of(resp):
    """First note of a discussion response, or {} on parse trouble."""
    if isinstance(resp, dict):
        notes = resp.get("notes") or [{}]
        return notes[0]
    return {}


def parse_json(raw, context):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"publish_comments: {context} response is not JSON:\n{raw}", file=sys.stderr)
        emit({"status": "failed"}, code=1)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("payload", help="payload JSON file (see module docstring)")
    args = ap.parse_args()

    try:
        payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"publish_comments: cannot read payload: {e}", file=sys.stderr)
        sys.exit(2)

    if not payload.get("url") or not payload.get("expected_head_sha"):
        print("publish_comments: payload needs url and expected_head_sha", file=sys.stderr)
        sys.exit(2)
    findings = payload.get("findings") or []
    if not findings and not payload.get("summary_note"):
        print("publish_comments: nothing to publish", file=sys.stderr)
        sys.exit(2)

    bad = hygiene(payload)
    if bad:
        emit({"status": "rejected", "reason": "forbidden local references in bodies", "items": bad}, code=4)

    loc = parse_url(payload["url"])
    host, project, iid, backend = loc["host"], loc["project"], loc["iid"], loc["backend"]

    if backend == "github":
        if shutil.which("gh") is None:
            print("publish_comments: gh not found in PATH", file=sys.stderr)
            emit({"status": "failed"}, code=1)
        proc = subprocess.run(["gh", "auth", "status", "--hostname", host],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            fail_raw(["gh", "auth", "status", "--hostname", host], proc)
        gh_publish(host, project, iid, payload, findings)
        return  # gh_publish emits the result and exits

    if shutil.which("glab") is None:
        print("publish_comments: glab not found in PATH", file=sys.stderr)
        emit({"status": "failed"}, code=1)
    proc = subprocess.run(["glab", "auth", "status", "--hostname", host],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        fail_raw(["glab", "auth", "status", "--hostname", host], proc)

    # Fresh diff_refs; never post positions from an old head.
    meta = json.loads(glab("api", f"projects/{enc(project)}/merge_requests/{iid}",
                           "--hostname", host))
    diff_refs = meta.get("diff_refs") or {}
    if diff_refs.get("head_sha") != payload["expected_head_sha"]:
        emit({
            "status": "head_moved",
            "expected": payload["expected_head_sha"],
            "actual": diff_refs.get("head_sha"),
        }, code=3)

    existing = json.loads(glab(
        "api", f"projects/{enc(project)}/merge_requests/{iid}/discussions?per_page=100",
        "--hostname", host))
    covered_pairs, covered_first_lines = set(), set()
    for d in existing if isinstance(existing, list) else []:
        for n in d.get("notes", []):
            pos = n.get("position") or {}
            if pos.get("new_path") or pos.get("old_path"):
                covered_pairs.add((pos.get("new_path") or pos.get("old_path"),
                                   pos.get("new_line"), pos.get("old_line")))
            body = (n.get("body") or "").strip()
            if body:
                covered_first_lines.add(body.splitlines()[0][:120])

    result = {"status": "published", "published": [], "skipped": [], "fallbacks": []}

    for f in findings:
        body_first = (f.get("body") or "").strip().splitlines()[0][:120] if f.get("body") else ""
        inline_capable = bool(f.get("file"))
        pair = (f.get("file"), f.get("new_line"), f.get("old_line"))
        if inline_capable and pair in covered_pairs:
            result["skipped"].append({"id": f.get("id"), "reason": "existing discussion on file+line"})
            continue
        if body_first and body_first in covered_first_lines:
            result["skipped"].append({"id": f.get("id"), "reason": "existing discussion with same opening line"})
            continue

        obj = {"body": f["body"]}
        if inline_capable:
            obj["position"] = position_for(f, diff_refs)

        proc = post_discussion(host, project, iid, obj)
        if proc.returncode != 0:
            if LINE_CODE_400.search(proc.stderr + proc.stdout):
                # Line not representable in the current diff -> summary note.
                proc2 = post_discussion(host, project, iid, {"body": f["body"]})
                if proc2.returncode != 0:
                    fail_raw(["glab", "api", ".../discussions", "--method", "POST"], proc2)
                resp = parse_json(proc2.stdout, "fallback summary POST")
                result["fallbacks"].append({
                    "id": f.get("id"), "to": "summary",
                    "reason": f"line not representable: {(proc.stderr or proc.stdout).strip()[:200]}",
                    "discussion_id": resp.get("id"),
                })
                result["published"].append({
                    "id": f.get("id"), "discussion_id": resp.get("id"),
                    "mode": "fallback-summary", "anchored": False,
                })
                continue
            fail_raw(["glab", "api", ".../discussions", "--method", "POST"], proc)

        resp = parse_json(proc.stdout, "discussion POST")
        note = note_of(resp)
        anchored = note.get("position") is not None
        entry = {
            "id": f.get("id"), "discussion_id": resp.get("id"),
            "mode": "inline" if inline_capable else "summary",
            "anchored": anchored,
            "line": (note.get("position") or {}).get("new_line") or (note.get("position") or {}).get("old_line"),
        }
        if inline_capable and not anchored:
            # Unanchored note: delete the note, fall back to a summary note.
            note_id = note.get("id")
            if note_id:
                glab("api", f"projects/{enc(project)}/merge_requests/{iid}/notes/{note_id}",
                     "--hostname", host, "--method", "DELETE")
            proc2 = post_discussion(host, project, iid, {"body": f["body"]})
            if proc2.returncode != 0:
                fail_raw(["glab", "api", ".../discussions", "--method", "POST"], proc2)
            resp2 = parse_json(proc2.stdout, "fallback summary POST")
            result["fallbacks"].append({
                "id": f.get("id"), "to": "summary",
                "reason": f"inline posted unanchored (discussion {resp.get('id')}); note deleted",
                "discussion_id": resp2.get("id"),
            })
            entry.update({"discussion_id": resp2.get("id"), "mode": "fallback-summary"})
        result["published"].append(entry)

    if payload.get("summary_note"):
        proc = post_discussion(host, project, iid, {"body": payload["summary_note"]["body"]})
        if proc.returncode != 0:
            fail_raw(["glab", "api", ".../discussions", "--method", "POST"], proc)
        resp = parse_json(proc.stdout, "summary POST")
        result["summary_discussion_id"] = resp.get("id")

    emit(result)


if __name__ == "__main__":
    main()
