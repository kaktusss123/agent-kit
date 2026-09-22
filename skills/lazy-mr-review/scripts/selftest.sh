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
  url="\$("$GIT_REAL" remote get-url "\$2" 2>/dev/null || true)"
  case "\$url" in
    https://gitlab.test/*)
      p="\${url#https://gitlab.test/}"; p="\${p%.git}"
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

URL="https://gitlab.test/group/proj/-/merge_requests/7"
SNAP="$HERE/review_snapshot.py"
PUB="$HERE/publish_comments.py"

echo "== snapshot: provided clone, happy path"
git clone -q "$T/mirror/proj.git" "$T/user"
git -C "$T/user" remote set-url origin https://gitlab.test/group/proj.git
export GLAB_STUB_LOG="$T/log-snap1.txt"; : > "$GLAB_STUB_LOG"
if out=$(python3 "$SNAP" "$URL" --clone "$T/user" --temp-root "$T/troot" 2>"$T/err1"); then
  check "exit 0, head_sha matches" test "$(jq -r '.reviews[0].head_sha' <<<"$out")" = "$SHA"
  check "checkout is a detached worktree" test "$(jq -r '.reviews[0].checkout.source' <<<"$out")" = "worktree"
  check "checkout HEAD verified" test "$(jq -r '.reviews[0].checkout.sha' <<<"$out")" = "$SHA"
  check "diff saved" test -s "$(jq -r '.reviews[0].diff_path' <<<"$out")"
  check "snapshot.json written" test -s "$T/troot/snapshot.json"
  check "hostname passed explicitly to glab api" grep -q -- '--hostname gitlab.test' "$GLAB_STUB_LOG"
  check "ci list got -R host/project" grep -q 'ci list -R gitlab.test/group/proj' "$GLAB_STUB_LOG"
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
  check "checkout source is clone" test "$(jq -r '.reviews[0].checkout.source' <<<"$out2")" = "clone"
else
  bad "no-clone failed: $(cat "$T/err3")"
fi
if out3=$("$SNAP" "$URL" --no-clone --temp-root "$T/troot2" 2>"$T/err3b"); then
  check "re-run reuses the same checkout" test "$(jq -r '.reviews[0].checkout.path' <<<"$out2")" = "$(jq -r '.reviews[0].checkout.path' <<<"$out3")"
else
  bad "re-run failed: $(cat "$T/err3b")"
fi

echo "== snapshot: non-MR URL rejected"
if python3 "$SNAP" "https://github.com/a/b/pull/7" --no-clone 2>/dev/null; then
  bad "github URL accepted"
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

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" = 0 ]
