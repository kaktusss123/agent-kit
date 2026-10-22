#!/usr/bin/env bash
# Selftest for review_snapshot.py and publish_comments.py.
# Runs both tools against a stub glab and a URL-rewriting git shim, so no
# network, GitLab, or glab installation is needed.
#
# Usage: bash selftest.sh    (exit 0 = all scenarios pass)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d /tmp/mr-review-selftest.XXXXXX)"
trap 'rm -rf "$T"' EXIT

REAL_GIT="$(command -v git)"
REAL_PATH="$PATH"
export GIT_MIRROR="$T/mirror/proj.git"
export GIT_REAL="$REAL_GIT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check() { # check <desc> <expr...>
  local desc="$1"; shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# ---------------------------------------------------------------- stubs
mkdir -p "$T/bin"

cat > "$T/bin/git" <<SHIM
#!/usr/bin/env bash
# Rewrite gitlab.test URLs (explicit or behind a remote name) to the local mirror.
args=("\$@")
if [ "\${1:-}" = "fetch" ] && [ -n "\${2:-}" ]; then
  url="\$2"
  case "\$url" in
    https://gitlab.test/*) : ;; # explicit server URL: rewrite below
    *) url="\$("$GIT_REAL" remote get-url "\$2" 2>/dev/null || true)" ;;
  esac
  case "\$url" in
    https://gitlab.test/*)
      args=("\$1" "\$GIT_MIRROR" "\${@:3}") ;;
  esac
fi
if [ "\${1:-}" = "clone" ]; then
  for i in "\${!args[@]}"; do
    a="\${args[\$i]}"
    case "\$a" in
      https://gitlab.test/*)
        p="\${a#https://gitlab.test/}"; p="\${p%.git}"
        args[\$i]="\$GIT_MIRROR" ;;
    esac
  done
fi
exec "\$GIT_REAL" "\${args[@]}"
SHIM

cat > "$T/bin/glab" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${GLAB_STUB_LOG:-}" ] && printf 'glab %s\n' "$*" >> "$GLAB_STUB_LOG"
sub="${1:-}"; shift || true
case "$sub" in
  auth) exit 0 ;;
  mr) echo "diff --git a/a.py b/a.py"; exit 0 ;;
  ci) echo "pipeline #123 main finished"; exit 0 ;;
esac
if [ "$sub" != "api" ]; then echo "stub: unknown subcommand $sub" >&2; exit 9; fi

path=""; method="GET"; input=""; prev=""
for a in "$@"; do
  case "$prev" in
    input)   input="$a";  prev=""; continue ;;
    method)  method="$a"; prev=""; continue ;;
    header|hostname) prev=""; continue ;;
  esac
  case "$a" in
    --hostname|--header) prev="$a" ;;
    --method) prev="method" ;;
    --input)  prev="input" ;;
    -*) prev="" ;;
    *) [ -z "$path" ] && path="$a" ;;
  esac
done

case "$path" in
  *"notes/"*)
    [ "$method" = "DELETE" ] && { echo '{}'; exit 0; } ;;
  *"/discussions"*)
    if [ "$method" = "GET" ]; then echo "${GLAB_STUB_EXISTING:-[]}"; exit 0; fi
    if [ "$method" = "POST" ]; then
      body="$(cat "$input")"
      case "${GLAB_STUB_SCENARIO:-ok}" in
        fallback400)
          if echo "$body" | grep -q '"position"'; then
            echo '400 Bad request - Note {:line_code=>["can'"'"'t be blank", "must be a valid line code"]}' >&2
            exit 1
          fi
          echo '{"id":"disc-sum","notes":[{"id":557,"body":"x","position":null}]}'; exit 0 ;;
        unanchored)
          if echo "$body" | grep -q '"position"'; then
            echo '{"id":"disc-un","notes":[{"id":556,"body":"x","position":null}]}'
          else
            echo '{"id":"disc-sum","notes":[{"id":557,"body":"x","position":null}]}'
          fi
          exit 0 ;;
        *)
          echo '{"id":"disc-new","notes":[{"id":555,"body":"x","position":{"new_line":23}}]}'
          exit 0 ;;
      esac
    fi ;;
  *"merge_requests/"*)
    if [[ "$path" =~ merge_requests/([0-9]+) ]]; then
      iid="${BASH_REMATCH[1]}"
      var="GLAB_STUB_MR_${iid}"
      if [ -n "${!var:-}" ]; then echo "${!var}"; exit 0; fi
    fi
    echo "${GLAB_STUB_MR}"; exit 0 ;;
esac
echo "stub: unhandled api path $path" >&2
exit 9
STUB

chmod +x "$T/bin/git" "$T/bin/glab"
export PATH="$T/bin:$REAL_PATH"

# ---------------------------------------------------------------- fixtures
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q -b main "$T/seed"
echo "def f():\n    return 1" > "$T/seed/a.py"
git -C "$T/seed" add a.py && git -C "$T/seed" commit -qm seed
SHA="$(git -C "$T/seed" rev-parse HEAD)"

git init -q --bare "$T/mirror/proj.git"
git -C "$T/mirror/proj.git" symbolic-ref HEAD refs/heads/main
git -C "$T/mirror/proj.git" fetch -q "$T/seed" main:main
git -C "$T/mirror/proj.git" update-ref refs/merge-requests/7/head "$SHA"

MR_JSON="$(jq -cn --arg sha "$SHA" '{
  title: "Add f", state: "opened", description: "",
  source_branch: "feat/x", target_branch: "main",
  author: {username: "someone"},
  diff_refs: {base_sha: "0000000000000000000000000000000000000000",
              start_sha: "1111111111111111111111111111111111111111",
              head_sha: $sha}}')"
export GLAB_STUB_MR="$MR_JSON"
export GLAB_STUB_MR_7="$MR_JSON"

URL="https://gitlab.test/group/proj/-/merge_requests/7"
URL8="https://gitlab.test/group/proj/-/merge_requests/8"

# Second commit: MR 8 head. MR 7 keeps pointing at the first SHA, so the two
# same-project MRs sit at different SHAs (MR-only refs, not branches).
echo "def g():" > "$T/seed/b.py"
echo "    return 2" >> "$T/seed/b.py"
git -C "$T/seed" add b.py && git -C "$T/seed" commit -qm second
SHA2="$(git -C "$T/seed" rev-parse HEAD)"
git -C "$T/mirror/proj.git" fetch -q "$T/seed" main:main
git -C "$T/mirror/proj.git" update-ref refs/merge-requests/8/head "$SHA2"
MR_JSON_8="$(jq -cn --arg sha "$SHA2" '{
  title: "Add g", state: "opened", description: "",
  source_branch: "feat/y", target_branch: "main",
  author: {username: "someone"},
  diff_refs: {base_sha: "0000000000000000000000000000000000000000",
              start_sha: "1111111111111111111111111111111111111111",
              head_sha: $sha}}')"
export GLAB_STUB_MR_8="$MR_JSON_8"
SNAP="$HERE/review_snapshot.py"
PUB="$HERE/publish_comments.py"

echo "== snapshot: provided clone, happy path"
git clone -q "$T/mirror/proj.git" "$T/user"
git -C "$T/user" remote set-url origin https://gitlab.test/group/proj.git
# Dirty working tree: the caller's clone must stay read-only (no fetch into it,
# no worktree registrations, dirty state preserved).
echo "# local scratch" >> "$T/user/a.py"
echo "scratch" > "$T/user/untracked.txt"
USER_STATUS_BEFORE="$(git -C "$T/user" status --porcelain)"
USER_WT_BEFORE="$(git -C "$T/user" worktree list)"
export GLAB_STUB_LOG="$T/log-snap1.txt"; : > "$GLAB_STUB_LOG"
if out=$(python3 "$SNAP" "$URL" --clone "$T/user" --temp-root "$T/troot" 2>"$T/err1"); then
  check "exit 0, head_sha matches" test "$(jq -r '.reviews[0].head_sha' <<<"$out")" = "$SHA"
  check "checkout is a detached worktree" test "$(jq -r '.reviews[0].checkout.source' <<<"$out")" = "worktree"
  check "checkout HEAD verified" test "$(jq -r '.reviews[0].checkout.sha' <<<"$out")" = "$SHA"
  check "diff saved" test -s "$(jq -r '.reviews[0].diff_path' <<<"$out")"
  check "snapshot.json written" test -s "$T/troot/snapshot.json"
  check "hostname passed explicitly to glab api" grep -q -- '--hostname gitlab.test' "$GLAB_STUB_LOG"
  check "ci list got -R host/project" grep -q 'ci list -R gitlab.test/group/proj' "$GLAB_STUB_LOG"
  check "caller clone status untouched" test "$(git -C "$T/user" status --porcelain)" = "$USER_STATUS_BEFORE"
  check "caller clone gained no worktrees" test "$(git -C "$T/user" worktree list)" = "$USER_WT_BEFORE"
  check "caller clone was never fetched into" bash -c '! git -C "$0" rev-parse FETCH_HEAD >/dev/null 2>&1' "$T/user"
else
  bad "snapshot exited non-zero: $(cat "$T/err1")"
fi

echo "== snapshot: clone with wrong remote is refused"
git clone -q "$T/mirror/proj.git" "$T/other"
git -C "$T/other" remote set-url origin https://gitlab.test/other/repo.git
if python3 "$SNAP" "$URL" --clone "$T/other" --temp-root "$T/troot" 2>"$T/err2"; then
  bad "mismatched remote accepted"
else
  check "exit 1" test $? = 1
  check "message names the mismatch" grep -q 'do not match gitlab.test/group/proj' "$T/err2"
fi

echo "== snapshot: --no-clone path and reuse on re-run"
if out2=$("$SNAP" "$URL" --no-clone --temp-root "$T/troot2" 2>"$T/err3"); then
  check "checkout is an isolated worktree" test "$(jq -r '.reviews[0].checkout.source' <<<"$out2")" = "worktree"
  check "fresh store fetched the MR-only ref" test "$(jq -r '.reviews[0].checkout.sha' <<<"$out2")" = "$SHA"
else
  bad "no-clone failed: $(cat "$T/err3")"
fi
if out3=$("$SNAP" "$URL" --no-clone --temp-root "$T/troot2" 2>"$T/err3b"); then
  check "re-run reuses the same checkout" test "$(jq -r '.reviews[0].checkout.path' <<<"$out2")" = "$(jq -r '.reviews[0].checkout.path' <<<"$out3")"
else
  bad "re-run failed: $(cat "$T/err3b")"
fi

echo "== snapshot: two same-project MRs get distinct checkouts at their own SHAs"
if outm=$(python3 "$SNAP" "$URL" "$URL8" --clone "$T/user" --temp-root "$T/trootm" 2>"$T/errm"); then
  p7="$(jq -r '.reviews[0].checkout.path' <<<"$outm")"
  p8="$(jq -r '.reviews[1].checkout.path' <<<"$outm")"
  check "checkout paths differ" test "$p7" != "$p8"
  check "MR 7 HEAD is its own SHA" test "$(jq -r '.reviews[0].checkout.sha' <<<"$outm")" = "$SHA"
  check "MR 8 HEAD is its own SHA" test "$(jq -r '.reviews[1].checkout.sha' <<<"$outm")" = "$SHA2"
  check "MR 7 files lack b.py" test ! -e "$p7/b.py"
  check "MR 8 files have b.py" test -e "$p8/b.py"
else
  bad "multi-MR snapshot failed: $(cat "$T/errm")"
fi
if outm2=$(python3 "$SNAP" "$URL" "$URL8" --clone "$T/user" --temp-root "$T/trootm" 2>"$T/errm2"); then
  check "re-run keeps both checkout paths" test "$(jq -r '.reviews[0].checkout.path' <<<"$outm2")" = "$p7"
  check "re-run keeps MR 8 checkout path" test "$(jq -r '.reviews[1].checkout.path' <<<"$outm2")" = "$p8"
  check "re-run keeps MR 7 SHA" test "$(jq -r '.reviews[0].checkout.sha' <<<"$outm2")" = "$SHA"
else
  bad "multi-MR re-run failed: $(cat "$T/errm2")"
fi

echo "== snapshot: moved MR head re-resolves the same checkout on re-run"
git -C "$T/mirror/proj.git" update-ref refs/merge-requests/7/head "$SHA2"
MR_JSON_MOVED="$(jq -cn --arg sha "$SHA2" '{title: "Add f", state: "opened", description: "",
  source_branch: "feat/x", target_branch: "main", author: {username: "someone"},
  diff_refs: {base_sha: "0000000000000000000000000000000000000000",
              start_sha: "1111111111111111111111111111111111111111", head_sha: $sha}}')"
export GLAB_STUB_MR_7="$MR_JSON_MOVED"
if outmv=$(python3 "$SNAP" "$URL" --clone "$T/user" --temp-root "$T/troot" 2>"$T/errmv"); then
  check "same checkout path reused" test "$(jq -r '.reviews[0].checkout.path' <<<"$outmv")" = "$(jq -r '.reviews[0].checkout.path' <<<"$out")"
  check "checkout HEAD follows the moved ref" test "$(jq -r '.reviews[0].checkout.sha' <<<"$outmv")" = "$SHA2"
else
  bad "moved-head re-run failed: $(cat "$T/errmv")"
fi
# Restore the MR 7 head for the scenarios below (they pin $SHA).
git -C "$T/mirror/proj.git" update-ref refs/merge-requests/7/head "$SHA"
export GLAB_STUB_MR_7="$MR_JSON"

echo "== snapshot: colliding project slugs get distinct identities"
URL_AB="https://gitlab.test/group/a-b/-/merge_requests/7"
URL_BA="https://gitlab.test/group-a/b/-/merge_requests/7"
if outc1=$(python3 "$SNAP" "$URL_AB" --no-clone --temp-root "$T/trootc" 2>"$T/errc1") && \
   outc2=$(python3 "$SNAP" "$URL_BA" --no-clone --temp-root "$T/trootc" 2>"$T/errc2"); then
  check "checkout paths differ" test "$(jq -r '.reviews[0].checkout.path' <<<"$outc1")" != "$(jq -r '.reviews[0].checkout.path' <<<"$outc2")"
  check "diff files differ" test "$(jq -r '.reviews[0].diff_path' <<<"$outc1")" != "$(jq -r '.reviews[0].diff_path' <<<"$outc2")"
  check "both checkouts verified" test "$(jq -r '.reviews[0].checkout.sha' <<<"$outc2")" = "$SHA"
else
  bad "colliding-slug snapshots failed: $(cat "$T/errc1" "$T/errc2" 2>/dev/null)"
fi

echo "== snapshot: stray dir at the checkout path is refused"
ROGUE="$(jq -r '.reviews[0].checkout.path' <<<"$outc1")"
rm -rf "$ROGUE"
git init -q "$ROGUE" && git -C "$ROGUE" commit -q --allow-empty -m rogue
if python3 "$SNAP" "$URL_AB" --no-clone --temp-root "$T/trootc" 2>"$T/errrogue"; then
  bad "stray checkout accepted"
else
  check "exit 1" test $? = 1
  check "message names the store mismatch" grep -q 'not registered' "$T/errrogue"
fi
rm -rf "$ROGUE"

echo "== snapshot: dirty reused checkout is refused, never reset"
DIRTY_TROOT="$T/trootd"
outd=$(python3 "$SNAP" "$URL" --no-clone --temp-root "$DIRTY_TROOT" 2>/dev/null)
DCO="$(jq -r '.reviews[0].checkout.path' <<<"$outd")"
echo "# review scratch" >> "$DCO/a.py"
echo "scratch" > "$DCO/untracked.txt"
if python3 "$SNAP" "$URL" --no-clone --temp-root "$DIRTY_TROOT" 2>"$T/errdirty"; then
  bad "dirty checkout accepted"
else
  check "exit 1" test $? = 1
  check "message names local changes" grep -q 'has local changes' "$T/errdirty"
  check "dirty tracked change preserved" grep -q 'review scratch' "$DCO/a.py"
  check "untracked file preserved" test -e "$DCO/untracked.txt"
fi

echo "== snapshot: symlinked store pointing at the caller clone is refused"
STORE_ID="$(python3 -c "import sys; sys.path.insert(0, '$HERE'); import review_snapshot as rs; print(rs.mr_identity('gitlab.test', 'group/proj'))")"
ATROOT="$T/troot-alias-sym"
mkdir -p "$ATROOT/repos"
ln -s "$T/user" "$ATROOT/repos/$STORE_ID"
USER_FETCH_BEFORE="$(git -C "$T/user" rev-parse FETCH_HEAD 2>&1 || true)"
USER_WT_BEFORE="$(git -C "$T/user" worktree list)"
USER_STATUS_BEFORE="$(git -C "$T/user" status --porcelain)"
if python3 "$SNAP" "$URL" --clone "$T/user" --temp-root "$ATROOT" 2>"$T/err-alias-sym"; then
  bad "symlinked store accepted"
else
  check "exit 1" test $? = 1
  check "message names the symlink" grep -q 'is a symlink' "$T/err-alias-sym"
  check "caller clone gained no FETCH_HEAD" test "$(git -C "$T/user" rev-parse FETCH_HEAD 2>&1 || true)" = "$USER_FETCH_BEFORE"
  check "caller clone gained no worktrees" test "$(git -C "$T/user" worktree list)" = "$USER_WT_BEFORE"
  check "caller clone status untouched" test "$(git -C "$T/user" status --porcelain)" = "$USER_STATUS_BEFORE"
fi

echo "== snapshot: store dir inside another repo is refused"
BTROOT="$T/troot-alias-enc"
mkdir -p "$BTROOT/repos/$STORE_ID"
git init -q -b main "$BTROOT"
ENC_FETCH_BEFORE="$(git -C "$BTROOT" rev-parse FETCH_HEAD 2>&1 || true)"
ENC_WT_BEFORE="$(git -C "$BTROOT" worktree list)"
if python3 "$SNAP" "$URL" --no-clone --temp-root "$BTROOT" 2>"$T/err-alias-enc"; then
  bad "enclosing-repo store accepted"
else
  check "exit 1" test $? = 1
  check "message names the standalone-root problem" grep -q 'not a standalone repository root' "$T/err-alias-enc"
  check "enclosing repo gained no FETCH_HEAD" test "$(git -C "$BTROOT" rev-parse FETCH_HEAD 2>&1 || true)" = "$ENC_FETCH_BEFORE"
  check "enclosing repo gained no worktrees" test "$(git -C "$BTROOT" worktree list)" = "$ENC_WT_BEFORE"
fi

echo "== snapshot: temp root inside the caller clone is refused"
if python3 "$SNAP" "$URL" --clone "$T/user" --temp-root "$T/user/tmproot" 2>"$T/err-alias-tmp"; then
  bad "in-clone temp root accepted"
else
  check "exit 1" test $? = 1
  check "message names the alias" grep -q 'aliases the caller clone' "$T/err-alias-tmp"
  check "nothing was created inside the caller clone" test ! -e "$T/user/tmproot"
fi

echo "== snapshot: unsupported URL rejected"
if python3 "$SNAP" "https://example.com/a/b/change/7" --no-clone 2>/dev/null; then
  bad "unsupported URL accepted"
else
  check "usage exit 2" test $? = 2
fi

# ---------------------------------------------------------------- publish
mk_payload() {
  jq -n --arg sha "$1" '{
    url: "https://gitlab.test/group/proj/-/merge_requests/7",
    expected_head_sha: $sha,
    summary_note: {body: "## Verdict\nblockers: 1"},
    findings: [
      {id: "F1", body: "BLOCKER: off-by-one", file: "a.py", new_line: 23},
      {id: "F2", body: "MINOR: naming", file: "a.py", new_line: 10},
      {id: "F3", body: "SAME FIRST LINE\nmore detail"},
      {id: "F4", body: "MAJOR: cross-file", file: "b.py", old_line: 5, new_line: 9}
    ]}'
}
EXISTING='[
 {"id":"d1","notes":[{"id":1,"body":"existing note","position":{"new_path":"a.py","new_line":10}}]},
 {"id":"d2","notes":[{"id":2,"body":"SAME FIRST LINE\nalready discussed","position":null}]}]'

echo "== publish: ok scenario (anchor, dedup, summary last)"
export GLAB_STUB_SCENARIO=ok GLAB_STUB_EXISTING="$EXISTING"
export GLAB_STUB_LOG="$T/log-pub-ok.txt"; : > "$GLAB_STUB_LOG"
mk_payload "$SHA" > "$T/payload-ok.json"
if out="$(python3 "$PUB" "$T/payload-ok.json" 2>"$T/errp1")"; then
  check "exit 0" test $? = 0
  check "status published" test "$(jq -r .status <<<"$out")" = published
  check "F1 inline anchored" test "$(jq -r '.published[] | select(.id=="F1") | .anchored' <<<"$out")" = true
  check "F2 skipped by file+line" test "$(jq -r '.skipped[] | select(.id=="F2") | .reason' <<<"$out")" = "existing discussion on file+line"
  check "F3 skipped by opening line" test "$(jq -r '.skipped[] | select(.id=="F3") | .reason' <<<"$out")" = "existing discussion with same opening line"
  check "F4 posted inline with old+new line" test "$(jq -r '.published[] | select(.id=="F4") | .mode' <<<"$out")" = inline
  check "summary posted once, last" test "$(grep -c 'glab api projects/group%2Fproj/merge_requests/7/discussions --hostname gitlab.test --method POST' "$GLAB_STUB_LOG")" = 3
  check "no payload file left behind" bash -c 'ls /tmp/publish_comments.* >/dev/null 2>&1; [ $? -ne 0 ]'
else
  bad "publish ok failed: $(cat "$T/errp1")"
fi

echo "== publish: head moved"
export GLAB_STUB_LOG="$T/log-pub-moved.txt"; : > "$GLAB_STUB_LOG"
mk_payload "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$T/payload-moved.json"
rc=0; out="$(python3 "$PUB" "$T/payload-moved.json" 2>"$T/errp2")" || rc=$?
check "exit 3" test "$rc" = 3
check "status head_moved" test "$(jq -r .status <<<"$out")" = head_moved
check "nothing was posted" bash -c '! grep -q "method POST" "$0"' "$GLAB_STUB_LOG"

echo "== publish: 400 line_code falls back to summary note"
export GLAB_STUB_SCENARIO=fallback400
export GLAB_STUB_LOG="$T/log-pub-400.txt"; : > "$GLAB_STUB_LOG"
mk_payload "$SHA" > "$T/payload-400.json"
rc=0; out="$(python3 "$PUB" "$T/payload-400.json" 2>"$T/errp3")" || rc=$?
check "exit 0 with fallbacks" test "$rc" = 0
check "F1 recorded as fallback-summary" test "$(jq -r '.published[] | select(.id=="F1") | .mode' <<<"$out")" = fallback-summary
check "fallback reason mentions line_code" grep -qi 'line_code' <(jq -r '.fallbacks[0].reason' <<<"$out")

echo "== publish: unanchored inline is deleted and re-posted as summary"
export GLAB_STUB_SCENARIO=unanchored
export GLAB_STUB_LOG="$T/log-pub-un.txt"; : > "$GLAB_STUB_LOG"
mk_payload "$SHA" > "$T/payload-un.json"
rc=0; out="$(python3 "$PUB" "$T/payload-un.json" 2>"$T/errp4")" || rc=$?
check "exit 0" test "$rc" = 0
check "F1 re-posted as fallback-summary" test "$(jq -r '.published[] | select(.id=="F1") | .mode' <<<"$out")" = fallback-summary
check "unanchored note deleted" grep -q 'notes/556 --hostname gitlab.test --method DELETE' "$GLAB_STUB_LOG"

echo "== publish: hygiene rejection"
export GLAB_STUB_SCENARIO=ok
export GLAB_STUB_LOG="$T/log-pub-hyg.txt"; : > "$GLAB_STUB_LOG"
jq '.findings[0].body = "Proof: see /tmp/proofs/x.py"' "$T/payload-ok.json" > "$T/payload-hyg.json"
rc=0; out="$(python3 "$PUB" "$T/payload-hyg.json" 2>"$T/errp5")" || rc=$?
check "exit 4" test "$rc" = 4
check "status rejected" test "$(jq -r .status <<<"$out")" = rejected
check "nothing was posted" bash -c '! grep -q "method POST" "$0"' "$GLAB_STUB_LOG"

# ----------------------------------------------------------------
# ---------------------------------------------------------------- GitHub backend
# The git shim grows a github.test rewrite; the glab stub stays in PATH (the
# tool must never call it for GitHub URLs — checked via GH_STUB_LOG isolation).
cat > "$T/bin/git" <<SHIM
#!/usr/bin/env bash
# Rewrite gitlab.test / github.test URLs (explicit or behind a remote name) to the local mirror.
args=("\$@")
if [ "\${1:-}" = "fetch" ] && [ -n "\${2:-}" ]; then
  url="\$2"
  case "\$url" in
    https://gitlab.test/*|https://github.test/*) : ;;
    *) url="\$("$GIT_REAL" remote get-url "\$2" 2>/dev/null || true)" ;;
  esac
  case "\$url" in
    https://gitlab.test/*|https://github.test/*)
      args=("\$1" "\$GIT_MIRROR" "\${@:3}") ;;
  esac
fi
if [ "\${1:-}" = "clone" ]; then
  for i in "\${!args[@]}"; do
    a="\${args[\$i]}"
    case "\$a" in
      https://gitlab.test/*|https://github.test/*)
        p="\${a#https://gitlab.test/}"; p="\${p#https://github.test/}"; p="\${p%.git}"
        args[\$i]="\$GIT_MIRROR" ;;
    esac
  done
fi
exec "\$GIT_REAL" "\${args[@]}"
SHIM

cat > "$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${GH_STUB_LOG:-}" ] && printf 'gh %s\n' "$*" >> "$GH_STUB_LOG"
sub="${1:-}"; shift || true
case "$sub" in
  auth) exit 0 ;;
  pr)
    mode="${1:-}"; shift || true
    case "$mode" in
      diff) echo "diff --git a/a.py b/a.py"; exit 0 ;;
      view)
        n="${1:-}"
        var="GH_STUB_PR_${n}"
        if [ -n "${!var+x}" ]; then echo "${!var}"; else echo '{}'; fi
        exit 0 ;;
    esac
    echo "stub: unknown pr mode $mode" >&2; exit 9 ;;
esac
if [ "$sub" != "api" ]; then echo "stub: unknown subcommand $sub" >&2; exit 9; fi
path=""; method="GET"; input=""; prev=""
for a in "$@"; do
  case "$prev" in
    input)   input="$a";  prev=""; continue ;;
    method)  method="$a"; prev=""; continue ;;
  esac
  case "$a" in
    --method) prev="method" ;;
    --input)  prev="input" ;;
    -*) prev="" ;;
    *) [ -z "$path" ] && path="$a" ;;
  esac
done
if [ "$sub" = "api" ] && [ "$method" = "POST" ] && [ -n "$input" ] && [ -n "${GH_STUB_LOG:-}" ]; then
  cat "$input" >> "$GH_STUB_LOG"
fi
case "$path" in
  *"/reviews/"*"/comments"*)
    # The default must not contain braces inline: ${VAR:-...} ends at the
    # FIRST unescaped '}', which would eat the JSON object's closing brace.
    rc_default='[{"path":"a.py","line":23}]'
    echo "${GH_STUB_REVIEW_COMMENTS:-$rc_default}"; exit 0 ;;
  *"/reviews")
    if [ "$method" = "POST" ]; then
      case "${GH_STUB_SCENARIO:-ok}" in
        fallback422)
          if [ -n "$input" ] && grep -q '"line"' "$input" 2>/dev/null; then
            echo '{"message":"Pull request review comments must be part of the diff","status":"422"}'
            echo 'gh: review comments must be part of the diff (HTTP 422)' >&2
            exit 1
          fi
          echo '{"id":9001}'; exit 0 ;;
        *)
          echo '{"id":8001}'; exit 0 ;;
      esac
    fi ;;
  *"pulls/"*"/comments"*)
    echo "${GH_STUB_PR_COMMENTS:-[]}"; exit 0 ;;
  *"issues/"*"/comments"*)
    if [ "$method" = "POST" ]; then echo '{"id":7001}'; exit 0; fi
    echo "${GH_STUB_ISSUE_COMMENTS:-[]}"; exit 0 ;;
esac
echo "stub: unhandled api path $path" >&2
exit 9
STUB
chmod +x "$T/bin/gh"

GH_URL="https://github.test/owner/proj/pull/7"
git -C "$T/mirror/proj.git" update-ref refs/pull/7/head "$SHA"
export GH_STUB_PR_7="$(jq -cn --arg sha "$SHA" '{
  number: 7, title: "Add f", state: "OPEN", body: "the body",
  author: {login: "someone"},
  headRefName: "feat/x", baseRefName: "main", headRefOid: $sha,
  url: "https://github.test/owner/proj/pull/7",
  statusCheckRollup: [{name: "verify", status: "completed", conclusion: "success"}]}')"

echo "== gh snapshot: provided clone, happy path"
git clone -q "$T/mirror/proj.git" "$T/ghuser"
git -C "$T/ghuser" remote set-url origin https://github.test/owner/proj.git
export GH_STUB_PR_COMMENTS='[{"path":"a.py","line":10,"body":"existing note"}]'
export GH_STUB_ISSUE_COMMENTS='[]'
export GH_STUB_LOG="$T/log-gh-snap.txt"; : > "$GH_STUB_LOG"
if outg=$(python3 "$SNAP" "$GH_URL" --clone "$T/ghuser" --temp-root "$T/ghroot" 2>"$T/gherr1"); then
  check "backend github" test "$(jq -r '.reviews[0].backend' <<<"$outg")" = github
  check "head_sha is headRefOid" test "$(jq -r '.reviews[0].head_sha' <<<"$outg")" = "$SHA"
  check "checkout HEAD verified" test "$(jq -r '.reviews[0].checkout.sha' <<<"$outg")" = "$SHA"
  check "branches mapped" test "$(jq -r '.reviews[0].source_branch' <<<"$outg")" = "feat/x"
  check "author mapped from login" test "$(jq -r '.reviews[0].author' <<<"$outg")" = "someone"
  check "pipeline carries the rollup" grep -q "verify: completed/success" <<<"$(jq -r '.reviews[0].pipeline[]' <<<"$outg")"
  check "diff saved" test -s "$(jq -r '.reviews[0].diff_path' <<<"$outg")"
  check "existing PR comment indexed" test "$(jq -r '.reviews[0].discussions[0].file' <<<"$outg")" = "a.py"
  check "glab never called for a GitHub URL" bash -c '! grep -q glab "$0"' "$GLAB_STUB_LOG"
  check "gh pr view hit the repo" grep -q 'pr view 7 --repo owner/proj' "$GH_STUB_LOG"
else
  bad "gh snapshot failed: $(cat "$T/gherr1")"
fi

mk_gh_payload() {
  jq -n --arg sha "$1" '{
    url: "https://github.test/owner/proj/pull/7",
    expected_head_sha: $sha,
    summary_note: {body: "## Verdict\nblockers: 1"},
    findings: [
      {id: "F1", body: "BLOCKER: off-by-one", file: "a.py", new_line: 23},
      {id: "F2", body: "MINOR: naming", file: "a.py", new_line: 10},
      {id: "F3", body: "NOTE: summary-level"},
      {id: "F4", body: "MAJOR: removed line", file: "b.py", old_line: 5}
    ]}'
}

echo "== gh publish: ok scenario (reviews, dedup, summary last)"
export GH_STUB_SCENARIO=ok
export GH_STUB_LOG="$T/log-gh-pub-ok.txt"; : > "$GH_STUB_LOG"
mk_gh_payload "$SHA" > "$T/gh-payload-ok.json"
if outg="$(python3 "$PUB" "$T/gh-payload-ok.json" 2>"$T/gherrp1")"; then
  check "status published" test "$(jq -r .status <<<"$outg")" = published
  check "F1 inline anchored" test "$(jq -r '.published[] | select(.id=="F1") | .anchored' <<<"$outg")" = true
  check "F2 skipped by file+line" test "$(jq -r '.skipped[] | select(.id=="F2") | .reason' <<<"$outg")" = "existing comment on file+line"
  check "F3 posted as issue comment" test "$(jq -r '.published[] | select(.id=="F3") | .mode' <<<"$outg")" = summary
  check "F4 inline via review" test "$(jq -r '.published[] | select(.id=="F4") | .mode' <<<"$outg")" = inline
  check "two review POSTs (F1, F4)" test "$(grep -c 'api --method POST --input .* repos/owner/proj/pulls/7/reviews' "$GH_STUB_LOG")" = 2
  check "two issue-comment POSTs (F3, summary)" test "$(grep -c 'api --method POST --input .* repos/owner/proj/issues/7/comments' "$GH_STUB_LOG")" = 2
  check "F4 uses the LEFT side" grep -Eq '"side": *"LEFT"' "$GH_STUB_LOG"
else
  bad "gh publish ok failed: $(cat "$T/gherrp1")"
fi

echo "== gh publish: head moved"
export GH_STUB_LOG="$T/log-gh-pub-moved.txt"; : > "$GH_STUB_LOG"
mk_gh_payload "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$T/gh-payload-moved.json"
rc=0; outg="$(python3 "$PUB" "$T/gh-payload-moved.json" 2>"$T/gherrp2")" || rc=$?
check "exit 3" test "$rc" = 3
check "status head_moved" test "$(jq -r .status <<<"$outg")" = head_moved
check "nothing was posted" bash -c '! grep -q -- "--method POST" "$0"' "$GH_STUB_LOG"

echo "== gh publish: 422 line-not-in-diff falls back to an issue comment"
export GH_STUB_SCENARIO=fallback422
export GH_STUB_LOG="$T/log-gh-pub-422.txt"; : > "$GH_STUB_LOG"
mk_gh_payload "$SHA" > "$T/gh-payload-422.json"
rc=0; outg="$(python3 "$PUB" "$T/gh-payload-422.json" 2>"$T/gherrp3")" || rc=$?
check "exit 0 with fallbacks" test "$rc" = 0
check "F1 recorded as fallback-summary" test "$(jq -r '.published[] | select(.id=="F1") | .mode' <<<"$outg")" = fallback-summary
check "fallback reason names the diff" grep -qi 'part of the diff' <(jq -r '.fallbacks[0].reason' <<<"$outg")
check "F3 still posted as summary (no line to reject)" test "$(jq -r '.published[] | select(.id=="F3") | .mode' <<<"$outg")" = summary

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" = 0 ]
