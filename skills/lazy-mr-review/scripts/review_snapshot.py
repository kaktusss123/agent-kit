#!/usr/bin/env python3
"""Build a review snapshot for one or more GitLab MRs.

Does the deterministic half of lazy-mr-review: glab preflight, MR metadata,
diff, pipeline status, existing discussions, and a verified checkout of the
review SHA. Writes <temp-root>/snapshot.json and prints it to stdout.

Usage:
    review_snapshot.py URL... (--clone PATH | --no-clone) [--temp-root DIR]

- URL: https://<host>/<group>/<project>/-/merge_requests/<iid> (repeatable for
  related MRs; all must share one project when --clone is used).
- --clone PATH: use the user's local clone (validated against the MR project).
- --no-clone: clone fresh into the temp root.
- --temp-root DIR: working directory for diffs, checkouts, snapshot.json.
  Defaults to a stable per-URL-set directory under the system temp dir, so a
  re-run reuses the existing checkout instead of re-cloning.

Exit codes: 0 ok, 1 preflight/checkout/validation failure (raw output is
printed), 2 usage error. CLI failures are reported raw: command, exit status,
stdout, stderr. Nothing is normalized.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

URL_RE = re.compile(r"^https?://([^/]+)/(.+?)/-/merge_requests/(\d+)/?$")


def die(msg, code=1):
    print(f"review_snapshot: {msg}", file=sys.stderr)
    sys.exit(code)


def fail_raw(cmd, proc):
    print(
        f"review_snapshot: command failed\n"
        f"  command: {' '.join(cmd)}\n"
        f"  exit: {proc.returncode}\n"
        f"  stdout:\n{proc.stdout}\n"
        f"  stderr:\n{proc.stderr}",
        file=sys.stderr,
    )
    sys.exit(1)


def run(cmd, *, cwd=None):
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    except FileNotFoundError:
        die(f"command not found: {cmd[0]}")
    if proc.returncode != 0:
        fail_raw(cmd, proc)
    return proc.stdout


def glab(*args):
    return run(["glab", *args])


def git(*args, cwd=None):
    return run(["git", *args], cwd=cwd)


def parse_url(url):
    m = URL_RE.match(url.strip())
    if not m:
        die(f"not a GitLab MR URL: {url}", code=2)
    return {"url": url.strip(), "host": m.group(1), "project": m.group(2), "iid": m.group(3)}


def enc(project):
    return project.replace("/", "%2F")


def preflight(host):
    if shutil.which("glab") is None:
        die("glab not found in PATH")
    proc = subprocess.run(
        ["glab", "auth", "status", "--hostname", host], capture_output=True, text=True
    )
    if proc.returncode != 0:
        fail_raw(["glab", "auth", "status", "--hostname", host], proc)


def normalize_remote(url):
    """Strip scheme, credentials, and trailing .git -> host/path."""
    u = url.strip().removesuffix(".git").removesuffix("/")
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^git@([^:]+):", r"\1/", u)
    u = re.sub(r"^[^/]+@", "", u)
    if "://" in url or u.count("/") == 0 and ":" in u:
        pass
    return u.strip("/")


def remote_matches(host, project, clone_path):
    out = git("remote", "-v", cwd=clone_path)
    urls = {line.split()[1] for line in out.splitlines() if line.strip()}
    want = f"{host}/{project}"
    for u in urls:
        if normalize_remote(u) == want:
            return True, u
    return False, ", ".join(sorted(urls)) or "(no remotes)"


def prepare_checkout(host, project, iid, head_sha, clone, temp_root):
    slug = project.replace("/", "-")
    if clone:
        if not Path(clone).is_dir():
            die(f"--clone {clone} does not exist")
        if git("rev-parse", "--is-inside-work-tree", cwd=clone).strip() != "true":
            die(f"--clone {clone} is not a git working tree")
        ok, seen = remote_matches(host, project, clone)
        if not ok:
            die(
                f"clone {clone} remotes do not match {host}/{project}; remotes: {seen}\n"
                "Do not proceed silently — report to the user and ask."
            )
        git("fetch", "origin", f"refs/merge-requests/{iid}/head", cwd=clone)
        fetched = git("rev-parse", "FETCH_HEAD", cwd=clone).strip()
        if fetched != head_sha:
            die(f"FETCH_HEAD {fetched} != head_sha {head_sha}")
        wt = Path(temp_root) / "worktrees" / slug
        if wt.exists():
            git("checkout", "--detach", head_sha, cwd=wt)
        else:
            run(["git", "worktree", "add", "--detach", str(wt), head_sha], cwd=clone)
        checkout, source = str(wt), "worktree"
    else:
        repo = Path(temp_root) / "repos" / slug
        if repo.exists():
            git("fetch", "origin", f"refs/merge-requests/{iid}/head", cwd=repo)
        else:
            repo.parent.mkdir(parents=True, exist_ok=True)
            run(["git", "clone", "--quiet", f"https://{host}/{project}.git", str(repo)])
        git("checkout", "--detach", head_sha, cwd=repo)
        checkout, source = str(repo), "clone"

    got = git("rev-parse", "HEAD", cwd=checkout).strip()
    if got != head_sha:
        die(f"checkout HEAD {got} != head_sha {head_sha}")
    return {"path": checkout, "sha": got, "source": source}


def discussions_index(host, project, iid):
    raw = glab("api", f"projects/{enc(project)}/merge_requests/{iid}/discussions?per_page=100",
               "--hostname", host)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        die(f"discussions response is not JSON:\n{raw}")
    out = []
    for d in data if isinstance(data, list) else []:
        for n in d.get("notes", []):
            pos = n.get("position") or {}
            body = (n.get("body") or "").strip()
            out.append({
                "discussion_id": d.get("id"),
                "file": pos.get("new_path") or pos.get("old_path"),
                "line": pos.get("new_line") or pos.get("old_line"),
                "body_start": body.splitlines()[0][:120] if body else "",
            })
    return out


def snapshot_one(mr, clone, temp_root):
    host, project, iid = mr["host"], mr["project"], mr["iid"]
    meta = json.loads(glab("api", f"projects/{enc(project)}/merge_requests/{iid}",
                           "--hostname", host))
    diff_refs = meta.get("diff_refs") or {}
    head_sha = diff_refs.get("head_sha")
    if not head_sha:
        die(f"MR {project}!{iid} has no diff_refs.head_sha")

    diffs_dir = Path(temp_root) / "diffs"
    diffs_dir.mkdir(parents=True, exist_ok=True)
    diff_path = diffs_dir / f"{project.replace('/', '-')}-{iid}.diff"
    diff_path.write_text(glab("mr", "diff", iid, "-R", f"{host}/{project}"), encoding="utf-8")

    ci = glab("ci", "list", "-R", f"{host}/{project}", "--ref", meta.get("source_branch") or "")
    pipeline = [line for line in ci.splitlines() if line.strip()]

    checkout = prepare_checkout(host, project, iid, head_sha, clone, temp_root)

    return {
        "url": mr["url"], "host": host, "project": project, "iid": int(iid),
        "title": meta.get("title"), "state": meta.get("state"),
        "author": (meta.get("author") or {}).get("username"),
        "source_branch": meta.get("source_branch"),
        "target_branch": meta.get("target_branch"),
        "description": meta.get("description"),
        "diff_refs": diff_refs, "head_sha": head_sha,
        "diff_path": str(diff_path),
        "pipeline": pipeline,
        "discussions": discussions_index(host, project, iid),
        "checkout": checkout,
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("urls", nargs="+", help="GitLab MR URLs")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--clone", help="path to the user's local clone")
    g.add_argument("--no-clone", action="store_true", help="clone fresh into the temp root")
    ap.add_argument("--temp-root", help="shared temp directory (default: stable per URL set)")
    args = ap.parse_args()

    mrs = [parse_url(u) for u in args.urls]
    hosts = {m["host"] for m in mrs}
    if len(hosts) > 1:
        die(f"URLs span several hosts: {sorted(hosts)}; run the tool once per host", code=2)
    if args.clone and len({(m["host"], m["project"]) for m in mrs}) > 1:
        die("--clone applies to one project; run per project or use --no-clone", code=2)

    host = mrs[0]["host"]
    preflight(host)

    if args.temp_root:
        temp_root = str(Path(args.temp_root).resolve())
        Path(temp_root).mkdir(parents=True, exist_ok=True)
    else:
        key = hashlib.sha1("\n".join(sorted(m["url"] for m in mrs)).encode()).hexdigest()[:10]
        temp_root = str(Path(tempfile.gettempdir()) / "lazy-mr-review" / key)
        Path(temp_root).mkdir(parents=True, exist_ok=True)

    result = {
        "temp_root": temp_root,
        "reviews": [snapshot_one(m, args.clone, temp_root) for m in mrs],
    }
    snap = Path(temp_root) / "snapshot.json"
    snap.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
