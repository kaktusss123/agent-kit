#!/usr/bin/env bash
#
# Snapshot CLI tests: `agent-kit snapshot <releases-dir>` manages the
# content-addressed release snapshots used by headless hosts.
#
# Every test runs in a fresh sandbox: a synthetic git checkout with the
# snapshot inputs (extensions/, node_modules/ with the four Pi runtime
# packages) and a separate releases directory. Nothing outside the sandbox is
# read or written; the real repository is only copied from.
#
# Usage: tests/snapshot/run.sh [-v]
#   -v  print snapshot output for each test
#
# Exit code: 0 when all tests pass, 1 otherwise.
set -euo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_REPO="$(cd "$SELF_DIR/.." && pwd -P)"
INSTALLER="$REAL_REPO/bin/agent-kit"

PKG_REL="node_modules/@earendil-works/pi-coding-agent/dist/index.js"
EXT_MARKER="extensions/subagents/index.ts"

SANDBOX=""
KIT=""
RELEASES=""
PASS=0
FAIL=0
FAIL_AT_START=0
CURRENT=""
RUN_PATH=""

# --- tiny assert helpers -----------------------------------------------------

fail() {
	FAIL=$((FAIL + 1))
	printf 'FAIL %s: %s\n' "$CURRENT" "$*" >&2
}

pass() {
	if [ "$FAIL" -eq "$FAIL_AT_START" ]; then
		PASS=$((PASS + 1))
		printf 'pass %s\n' "$CURRENT"
	else
		printf 'FAIL %s (see above)\n' "$CURRENT"
	fi
}

assert_eq() { # <got> <want> <what>
	if [ "$1" != "$2" ]; then
		fail "$3: got '$1', want '$2'"
	fi
}

assert_file() { # <path> <what>
	[ -f "$1" ] || fail "$2: missing file $1"
}

assert_dir() { # <path> <what>
	[ -d "$1" ] || fail "$2: missing directory $1"
}

assert_no_file() { # <path> <what> — dangling symlinks count as existing
	if [ -e "$1" ] || [ -L "$1" ]; then
		fail "$2: path should not exist: $1"
	fi
}

assert_link() { # <path> <expected-target> <what>
	if [ ! -L "$1" ]; then
		fail "$3: not a symlink: $1"
		return
	fi
	assert_eq "$(readlink "$1")" "$2" "$3"
}

assert_grep() { # <path> <fixed string> <what>
	if ! grep -Fq -- "$2" "$1"; then
		fail "$3: '$2' not found in $1"
	fi
}

assert_contains() { # <text> <fixed string> <what>
	case "$1" in
	*"$2"*) : ;;
	*) fail "$3: '$2' not found in: $1" ;;
	esac
}

# --- sandbox -----------------------------------------------------------------

new_test() { # <name>
	CURRENT="$1"
	FAIL_AT_START=$FAIL
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	[ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
	SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-snapshot.XXXXXX")"
	SANDBOX="$(cd "$SANDBOX" && pwd -P)"
	KIT="$SANDBOX/kit"
	RELEASES="$SANDBOX/releases"
	RUN_PATH=""
	unset AGENT_KIT_ROOT 2>/dev/null || true
}

cleanup() {
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	[ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
}
trap cleanup EXIT

# Synthetic checkout: the snapshot inputs plus the installer under test.
make_kit() { # <checkout-dir>
	local d="$1"
	mkdir -p "$d/bin" "$d/extensions/alpha" "$d/extensions/subagents" \
		"$d/node_modules/@earendil-works/pi-coding-agent/dist" \
		"$d/node_modules/@earendil-works/pi-ai" \
		"$d/node_modules/@earendil-works/pi-tui" \
		"$d/node_modules/typebox"
	cp "$INSTALLER" "$d/bin/agent-kit"
	printf 'export const alpha = 1\n' > "$d/extensions/alpha/index.ts"
	printf 'export const subagents = 1\n' > "$d/$EXT_MARKER"
	printf 'export const pkg = "pi-coding-agent"\n' > "$d/$PKG_REL"
	printf 'export const pkg = "pi-ai"\n' > "$d/node_modules/@earendil-works/pi-ai/index.js"
	printf 'export const pkg = "pi-tui"\n' > "$d/node_modules/@earendil-works/pi-tui/index.js"
	printf 'export const pkg = "typebox"\n' > "$d/node_modules/typebox/index.js"
	printf 'node_modules\n' > "$d/.gitignore"
	git -C "$d" init -q
	git_commit_all "$d" "initial"
}

git_commit_all() { # <repo> <message> — commit every change with a fixed identity
	git -C "$1" add -A
	git -C "$1" -c user.email=agent-kit@test -c user.name=agent-kit commit -qm "$2"
}

head_sha() {
	git -C "$KIT" rev-parse HEAD
}

run_snapshot_at() { # <root> <releases-dir> — sets OUT and RC
	if OUT="$(PATH="${RUN_PATH:+$RUN_PATH:}$PATH" AGENT_KIT_ROOT="$1" "$INSTALLER" snapshot "$2" 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

run_snapshot() { # sets OUT and RC for the sandbox checkout
	run_snapshot_at "$KIT" "$RELEASES"
}

tmp_dirs() {
	find "$RELEASES" -mindepth 1 -maxdepth 1 -name '.tmp-*' 2>/dev/null | wc -l | tr -d ' '
}

snapshot_dirs() { # 40-hex snapshot directories, current excluded
	local dir base n=0
	for dir in "$RELEASES"/*/; do
		[ -d "$dir" ] || continue
		base="${dir%/}"
		base="${base##*/}"
		[ "${#base}" -eq 40 ] || continue
		case "$base" in *[!0-9a-f]*) continue ;; esac
		n=$((n + 1))
	done
	printf '%s' "$n"
}

fake_snapshot() { # <n> <touch-date> — a retention candidate with a 40-hex name
	local name
	name="$(printf '%040d' "$1")"
	mkdir -p "$RELEASES/$name"
	printf '{}\n' > "$RELEASES/$name/manifest.json"
	touch -d "$2" "$RELEASES/$name"
}

# --- fault injection shims ---------------------------------------------------
#
# Whether rm fails on an unwritable directory depends on the uid running the
# suite (root ignores DAC), so destructive failures are reproduced through a
# PATH shim that delegates to the real rm. Two modes:
#   strict  refuse to remove a tree holding a directory without u+w, exactly
#           like rm running as an unprivileged user
#   refuse  refuse every path matching a line of $SANDBOX/rm-refuse
make_shims() {
	local shim
	for shim in strict refuse; do
		mkdir -p "$SANDBOX/shim-$shim"
		{
			printf '#!/usr/bin/env bash\n'
			printf 'real_rm=%q\n' "$(command -v rm)"
			printf 'refuse_file=%q\n' "$SANDBOX/rm-refuse"
			printf 'mode=%q\n' "$shim"
			cat <<'EOSH'
for arg in "$@"; do
	case "$arg" in -*) continue ;; esac
	if [ "$mode" = strict ]; then
		[ -d "$arg" ] || continue
		if find "$arg" -type d ! -perm -u+w -print -quit 2>/dev/null | grep -q .; then
			printf 'rm: cannot remove %s: Permission denied\n' "$arg" >&2
			exit 1
		fi
		continue
	fi
	[ -f "$refuse_file" ] || continue
	while IFS= read -r pattern; do
		[ -n "$pattern" ] || continue
		case "$arg" in
		*"$pattern"*)
			printf 'rm: cannot remove %s: Permission denied\n' "$arg" >&2
			exit 1
			;;
		esac
	done < "$refuse_file"
done
exec "$real_rm" "$@"
EOSH
		} > "$SANDBOX/shim-$shim/rm"
		chmod +x "$SANDBOX/shim-$shim/rm"
	done
}

count_lines() { # <text> — non-empty lines
	printf '%s\n' "$1" | grep -c . || true
}

# ==============================================================================
# T1: a fresh snapshot materializes extensions, node_modules and the manifest,
# then flips current at the full HEAD sha

new_test "T1 fresh snapshot"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "exit code"
MANIFEST="$RELEASES/$SHA/manifest.json"
	assert_file "$MANIFEST" "manifest"
	assert_grep "$MANIFEST" '"schema": 1' "manifest schema"
	assert_grep "$MANIFEST" "\"sha\": \"$SHA\"" "manifest sha"
	assert_grep "$MANIFEST" '"dirty": false' "manifest dirty flag"
	assert_grep "$MANIFEST" '"createdAt": "' "manifest createdAt"
	assert_grep "$MANIFEST" "\"source\": \"$KIT\"" "manifest source"
	assert_file "$RELEASES/$SHA/extensions/alpha/index.ts" "extensions copy"
	assert_grep "$RELEASES/$SHA/extensions/alpha/index.ts" 'alpha = 1' "extensions content"
	assert_file "$RELEASES/$SHA/$PKG_REL" "node_modules copy"
	assert_link "$RELEASES/current" "$SHA" "current symlink"
	assert_file "$RELEASES/current/manifest.json" "current resolves to a complete snapshot"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
	assert_eq "$(snapshot_dirs)" 1 "exactly one snapshot"
pass

# ==============================================================================
# T2: the fast path copies nothing, leaves the snapshot untouched, and still
# repairs a current symlink that points elsewhere

new_test "T2 fast path is a no-op"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
EXT_INODE="$(stat -c %i "$RELEASES/$SHA/extensions/alpha/index.ts")"
MANIFEST_INODE="$(stat -c %i "$RELEASES/$SHA/manifest.json")"
DIR_MTIME="$(stat -c %Y "$RELEASES/$SHA")"
# Point current away from the existing snapshot: the fast path must flip it
# back instead of copying again.
ln -sfn "$(printf '%040d' 0)" "$RELEASES/current"
run_snapshot
	assert_eq "$RC" 0 "second snapshot"
	assert_contains "$OUT" "already present" "fast path reporting"
	assert_link "$RELEASES/current" "$SHA" "current repaired"
	assert_eq "$(stat -c %i "$RELEASES/$SHA/extensions/alpha/index.ts")" "$EXT_INODE" "extensions not copied"
	assert_eq "$(stat -c %i "$RELEASES/$SHA/manifest.json")" "$MANIFEST_INODE" "manifest not rewritten"
	assert_eq "$(stat -c %Y "$RELEASES/$SHA")" "$DIR_MTIME" "snapshot dir untouched"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T3: uncommitted changes are snapshotted and flagged, not rejected

new_test "T3 dirty tree manifest flag"
make_kit "$KIT"
SHA="$(head_sha)"
printf '\n// dirty change\n' >> "$KIT/extensions/alpha/index.ts"
run_snapshot
	assert_eq "$RC" 0 "dirty snapshot succeeds"
	assert_grep "$RELEASES/$SHA/manifest.json" '"dirty": true' "dirty flag"
	assert_grep "$RELEASES/$SHA/extensions/alpha/index.ts" 'dirty change' "working tree content"
git_commit_all "$KIT" "dirty change"
SHA2="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "clean snapshot"
	assert_grep "$RELEASES/$SHA2/manifest.json" '"dirty": false' "clean flag"
pass

# ==============================================================================
# T4: node_modules is hardlinked from the previous current, extensions are a
# real copy
#
# The source file is replaced with a NEW inode before the second run: otherwise
# "the same inode" would hold even if the second snapshot copied from the
# checkout instead of the previous current.

new_test "T4 hardlink reuse from previous current"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
INODE1="$(stat -c %i "$RELEASES/$SHA1/$PKG_REL")"
	assert_eq "$(stat -c %i "$KIT/$PKG_REL")" "$INODE1" "first snapshot hardlinks from the checkout"
printf 'export const pkg = "pi-coding-agent-v2"\n' > "$KIT/$PKG_REL.new"
mv -f "$KIT/$PKG_REL.new" "$KIT/$PKG_REL"
	if [ "$(stat -c %i "$KIT/$PKG_REL")" = "$INODE1" ]; then
		fail "test setup: the checkout file must have a new inode"
	fi
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "second snapshot"
	assert_eq "$(stat -c %i "$RELEASES/$SHA2/$PKG_REL")" "$INODE1" "node_modules hardlinked from previous current, not from the checkout"
	assert_grep "$RELEASES/$SHA2/$PKG_REL" 'pi-coding-agent"' "previous current content, not the checkout's new content"
	assert_eq "$(stat -c %h "$RELEASES/$SHA2/$PKG_REL")" 2 "previous snapshot and the new one share the inode"
	if [ "$(stat -c %i "$RELEASES/$SHA1/extensions/alpha/index.ts")" = \
		"$(stat -c %i "$RELEASES/$SHA2/extensions/alpha/index.ts")" ]; then
		fail "extensions must be a real copy, not a hardlink"
	fi
	assert_grep "$RELEASES/$SHA2/extensions/alpha/index.ts" '// next' "new extensions content"
	assert_link "$RELEASES/current" "$SHA2" "current flipped"
pass

# ==============================================================================
# T5: retention keeps current's target plus the newest 5 snapshots, on both the
# fast path and a fresh snapshot, and prunes the rest

new_test "T5 retention"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020-01-0$i 00:00:00"
	i=$((i + 1))
done
run_snapshot
	assert_eq "$RC" 0 "fast path with retention"
	assert_link "$RELEASES/current" "$SHA1" "current kept"
	assert_no_file "$RELEASES/$(printf '%040d' 1)" "oldest candidate pruned"
	assert_dir "$RELEASES/$(printf '%040d' 2)" "newest candidates kept"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "fresh snapshot with retention"
	assert_link "$RELEASES/current" "$SHA2" "current flipped"
	assert_dir "$RELEASES/$SHA1" "previous current retained as one of the newest"
	assert_no_file "$RELEASES/$(printf '%040d' 2)" "next oldest candidate pruned"
	assert_dir "$RELEASES/$(printf '%040d' 3)" "newest candidates kept"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
	assert_file "$RELEASES/current/manifest.json" "current resolves"
pass

# ==============================================================================
# T6: detached HEAD and non-git checkouts are refused without touching current

new_test "T6 refusals leave current untouched"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
git -C "$KIT" checkout -q --detach
run_snapshot
	assert_eq "$RC" 2 "detached HEAD refused"
	assert_contains "$OUT" "detached HEAD" "detached HEAD message"
	assert_link "$RELEASES/current" "$SHA" "current untouched"
	mkdir -p "$SANDBOX/plain/bin"
	cp "$INSTALLER" "$SANDBOX/plain/bin/agent-kit"
	run_snapshot_at "$SANDBOX/plain" "$RELEASES"
	assert_eq "$RC" 2 "non-git checkout refused"
	assert_contains "$OUT" "not a git checkout" "non-git message"
	assert_link "$RELEASES/current" "$SHA" "current untouched"
	if OUT="$(AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 2 "missing releases-dir argument refused"
	assert_contains "$OUT" "exactly one argument" "argument message"
	assert_link "$RELEASES/current" "$SHA" "current untouched"
pass

# ==============================================================================
# T7: a failure during materialization exits non-zero with bounded output,
# removes the temp dir and leaves current untouched

new_test "T7 failed materialization leaves current untouched"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# A dangling symlink makes the hardlink copy and its real-copy fallback fail.
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 2 "materialization failure"
	assert_contains "$OUT" "could not copy node_modules" "bounded failure message"
LINES="$(printf '%s\n' "$OUT" | grep -c . || true)"
	if [ "$LINES" -gt 3 ]; then
		fail "stderr must stay bounded, got $LINES lines: $OUT"
	fi
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_no_file "$RELEASES/$SHA2" "no final dir for the failed snapshot"
	assert_eq "$(tmp_dirs)" 0 "temp dir cleaned"
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds"
	assert_link "$RELEASES/current" "$SHA2" "current advanced after recovery"
pass

# ==============================================================================
# T8: an existing final-name directory is never overwritten silently

new_test "T8 existing final dir is not overwritten"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
mkdir "$RELEASES/$SHA2"
run_snapshot
	assert_eq "$RC" 2 "incomplete existing dir refused"
	assert_contains "$OUT" "not a complete snapshot" "conflict message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_eq "$(tmp_dirs)" 0 "temp dir cleaned"
pass

# ==============================================================================
# T9: current resolves at every observed moment while a new snapshot is built

new_test "T9 current never dangles"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
(
	if AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out" 2>&1; then
		printf 0 > "$SANDBOX/rc"
	else
		printf '%s' "$?" > "$SANDBOX/rc"
	fi
) &
PID=$!
BROKEN=0
while kill -0 "$PID" 2>/dev/null; do
	if [ ! -f "$RELEASES/current/manifest.json" ] || [ ! -f "$RELEASES/current/$EXT_MARKER" ]; then
		BROKEN=1
	fi
done
wait "$PID" || true
	assert_eq "$(cat "$SANDBOX/rc")" 0 "snapshot exit code"
	assert_eq "$BROKEN" 0 "current always resolved during the run"
	assert_link "$RELEASES/current" "$SHA2" "current flipped after completion"
pass

# ==============================================================================
# T10: help text documents the subcommand

new_test "T10 help text"
OUT="$("$INSTALLER" help 2>&1)"
	assert_contains "$OUT" "agent-kit snapshot <releases-dir>" "help usage"
	assert_contains "$OUT" "current" "help current contract"
pass

# ==============================================================================
# T11: a same-named directory is only trusted after a strict completeness check;
# an incomplete artifact is refused instead of being flipped to

new_test "T11 incomplete artifacts are refused"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# (a) empty payload plus a text file that happens to contain the sha: the old
# grep-based fast path accepted and flipped to it.
mkdir -p "$RELEASES/$SHA2/extensions" "$RELEASES/$SHA2/node_modules"
printf 'a text file mentioning "sha": "%s"\n' "$SHA2" > "$RELEASES/$SHA2/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "text manifest refused"
	assert_contains "$OUT" "not a complete snapshot" "text manifest message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the text manifest"
# (b) a structurally valid manifest over an empty payload
cp "$RELEASES/$SHA1/manifest.json" "$RELEASES/$SHA2/manifest.json"
sed -i "s/$SHA1/$SHA2/" "$RELEASES/$SHA2/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "empty payload refused"
	assert_contains "$OUT" "not a complete snapshot" "empty payload message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the empty payload"
# (c) a complete copy that lacks a runtime package, and (d) one that lacks the
# extensions marker, are both refused as artifacts of another sha
printf '\n// third\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "third"
SHA3="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "third snapshot"
printf '\n// fourth\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "fourth"
SHA4="$(head_sha)"
mkdir "$RELEASES/$SHA4"
cp -a "$RELEASES/$SHA3/." "$RELEASES/$SHA4/"
sed -i "s/$SHA3/$SHA4/" "$RELEASES/$SHA4/manifest.json"
rm -rf "$RELEASES/$SHA4/node_modules/typebox"
run_snapshot
	assert_eq "$RC" 2 "missing runtime package refused"
	assert_contains "$OUT" "not a complete snapshot" "missing package message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the missing package"
cp -a "$RELEASES/$SHA3/node_modules/typebox" "$RELEASES/$SHA4/node_modules/typebox"
rm -rf "$RELEASES/$SHA4/extensions/subagents"
run_snapshot
	assert_eq "$RC" 2 "missing extensions marker refused"
	assert_contains "$OUT" "not a complete snapshot" "missing marker message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the missing marker"
# (e) a manifest with an unexpected field is not one of ours
mkdir -p "$RELEASES/$SHA4/extensions/subagents"
printf 'export const subagents = 1\n' > "$RELEASES/$SHA4/$EXT_MARKER"
sed -i '4i\  "extra": 1,' "$RELEASES/$SHA4/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "extra manifest field refused"
	assert_contains "$OUT" "not a complete snapshot" "extra field message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the extra field"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T12: a 0555 directory copied by cp -a must not block the cleanup of a failed
# temp dir (rm cannot descend into a directory it cannot write to)

new_test "T12 failed materialization cleans a 0555 temp tree"
make_kit "$KIT"
chmod 0555 "$KIT/extensions/alpha"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot with a 0555 source dir"
	assert_file "$RELEASES/$SHA1/extensions/alpha/index.ts" "0555 dir copied"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
make_shims
# A dangling symlink makes the hardlink copy and its real-copy fallback fail;
# the strict shim refuses to remove the tmp tree while it holds a 0555 dir.
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
RUN_PATH="$SANDBOX/shim-strict"
run_snapshot
	assert_eq "$RC" 2 "materialization failure"
	assert_no_file "$RELEASES/$SHA2" "no final dir for the failed snapshot"
	assert_eq "$(tmp_dirs)" 0 "0555 temp tree removed"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_eq "$(printf '%s\n' "$OUT" | grep -c 'could not remove the temporary directory' || true)" 0 "no cleanup warning"
RUN_PATH=""
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds"
pass

# ==============================================================================
# T13: when cleanup cannot remove the temp dir at all, it reports exactly one
# bounded warning naming it instead of failing silently

new_test "T13 unremovable temp dir warns once"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
make_shims
printf '.tmp-\n' > "$SANDBOX/rm-refuse"
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
RUN_PATH="$SANDBOX/shim-refuse"
run_snapshot
	assert_eq "$RC" 2 "materialization failure"
	assert_eq "$(printf '%s\n' "$OUT" | grep -c 'could not remove the temporary directory' || true)" 1 "exactly one cleanup warning"
WARNING="$(printf '%s\n' "$OUT" | grep 'could not remove the temporary directory' || true)"
	assert_contains "$WARNING" ".tmp-" "warning names the temp dir"
	if [ "${#WARNING}" -gt 300 ]; then
		fail "cleanup warning must stay bounded, got ${#WARNING} chars"
	fi
	if [ "$(tmp_dirs)" -ne 1 ]; then
		fail "expected exactly one leftover temp dir, got $(tmp_dirs)"
	fi
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
RUN_PATH=""
# Restore a clean sandbox for the final assertions and the trap.
chmod -R u+w "$RELEASES"/.tmp-* 2>/dev/null || true
rm -rf "$RELEASES"/.tmp-*
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
pass

# ==============================================================================
# T14: an old snapshot that cannot be removed is non-fatal: exit 0, current on
# the new snapshot, exactly one bounded warning naming the directory

new_test "T14 unprunable old snapshot is non-fatal"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020-01-0$i 00:00:00"
	i=$((i + 1))
done
make_shims
OLD="$(printf '%040d' 1)"
printf '%s\n' "$OLD" > "$SANDBOX/rm-refuse"
RUN_PATH="$SANDBOX/shim-refuse"
run_snapshot
	assert_eq "$RC" 0 "prune failure keeps exit 0"
RUN_PATH=""
	assert_link "$RELEASES/current" "$SHA" "current still on the snapshot of HEAD"
	assert_dir "$RELEASES/$OLD" "undeletable directory left in place"
	assert_eq "$(printf '%s\n' "$OUT" | grep -c 'could not remove the old snapshot' || true)" 1 "exactly one prune warning"
WARNING="$(printf '%s\n' "$OUT" | grep 'could not remove the old snapshot' || true)"
	assert_contains "$WARNING" "$OLD" "warning names the failing directory"
	if [ "${#WARNING}" -gt 300 ]; then
		fail "prune warning must stay bounded, got ${#WARNING} chars"
	fi
	assert_dir "$RELEASES/$(printf '%040d' 2)" "pruning continued past the failure"
	assert_eq "$(snapshot_dirs)" 7 "current plus five newest plus the undeletable one"
pass

# ==============================================================================
# T15: every operation on a releases dir is serialized by an exclusive lock

wait_for_lock_taken() { # <lockfile> — true once another process holds it
	local i=0
	while [ "$i" -lt 100 ]; do
		if ! flock -n "$1" true 2>/dev/null; then
			return 0
		fi
		sleep 0.05
		i=$((i + 1))
	done
	return 1
}

new_test "T15 snapshot operations take the releases lock"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
# A held lock makes the otherwise instant fast path wait for it.
flock -x "$RELEASES/.lock" -c 'sleep 3' &
HOLDER=$!
if ! wait_for_lock_taken "$RELEASES/.lock"; then
	fail "test setup: could not observe the held lock"
fi
( if AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=30 AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out" 2>&1; then printf 0 > "$SANDBOX/rc"; else printf '%s' "$?" > "$SANDBOX/rc"; fi ) &
WAITER=$!
sleep 1
	if ! kill -0 "$WAITER" 2>/dev/null; then
		fail "the fast path did not wait for the releases lock"
	fi
wait "$HOLDER" || true
wait "$WAITER" || true
	assert_eq "$(cat "$SANDBOX/rc")" 0 "waiter exit code"
	assert_contains "$(cat "$SANDBOX/out")" "already present" "waiter completed the fast path"
	assert_link "$RELEASES/current" "$SHA" "current intact after the wait"
# A lock that cannot be taken in the bounded wait is a clear, bounded error.
BEFORE="$(readlink "$RELEASES/current")"
flock -x "$RELEASES/.lock" -c 'sleep 4' &
HOLDER=$!
if ! wait_for_lock_taken "$RELEASES/.lock"; then
	fail "test setup: could not observe the held lock"
fi
AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=1 run_snapshot
wait "$HOLDER" || true
	if [ "$RC" -eq 0 ]; then
		fail "a timed-out lock must not exit 0"
	fi
	assert_contains "$OUT" "another snapshot is running" "lock timeout message"
	if [ "$(count_lines "$OUT")" -gt 2 ]; then
		fail "lock timeout output must stay bounded, got $(count_lines "$OUT") lines"
	fi
	assert_eq "$(readlink "$RELEASES/current")" "$BEFORE" "current untouched on lock timeout"
pass

# ==============================================================================
# T16: the reviewer's race — one process prunes while another flips current onto
# the pruned candidate. With the lock both are serialized, so current never
# dangles and both processes agree on a complete snapshot.

new_test "T16 concurrent snapshots never dangle current"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
cp -a "$KIT" "$SANDBOX/kit2"
printf '\n// second checkout\n' >> "$SANDBOX/kit2/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit2" "second"
SHA2="$(git -C "$SANDBOX/kit2" rev-parse HEAD)"
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020-01-0$i 00:00:00"
	i=$((i + 1))
done
: > "$SANDBOX/watch"
(
	while [ ! -f "$SANDBOX/stop-watch" ]; do
		if [ ! -f "$RELEASES/current/$EXT_MARKER" ] || [ ! -f "$RELEASES/current/manifest.json" ]; then
			printf 'dangling\n' >> "$SANDBOX/watch"
		fi
		sleep 0.01
	done
) &
WATCHER=$!
( if AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >/dev/null 2>"$SANDBOX/err-old"; then printf 0 > "$SANDBOX/rc-old"; else printf '%s' "$?" > "$SANDBOX/rc-old"; fi ) &
P1=$!
( if AGENT_KIT_ROOT="$SANDBOX/kit2" "$INSTALLER" snapshot "$RELEASES" >/dev/null 2>"$SANDBOX/err-new"; then printf 0 > "$SANDBOX/rc-new"; else printf '%s' "$?" > "$SANDBOX/rc-new"; fi ) &
P2=$!
wait "$P1" || true
wait "$P2" || true
touch "$SANDBOX/stop-watch"
wait "$WATCHER" || true
	assert_eq "$(cat "$SANDBOX/rc-old")" 0 "fast-path process exit code"
	assert_eq "$(cat "$SANDBOX/rc-new")" 0 "materializing process exit code"
	assert_eq "$(wc -l < "$SANDBOX/watch" | tr -d ' ')" 0 "current never dangled"
TARGET="$(readlink -f "$RELEASES/current" || true)"
	[ -n "$TARGET" ] || fail "current does not resolve after both runs"
	case "${TARGET##*/}" in
	"$SHA1"|"$SHA2") : ;;
	*) fail "current points at an unexpected snapshot: $TARGET" ;;
	esac
	assert_file "$TARGET/manifest.json" "current target has a manifest"
	assert_file "$TARGET/$EXT_MARKER" "current target has extensions"
	assert_dir "$TARGET/node_modules/typebox" "current target has node_modules"
	assert_grep "$TARGET/manifest.json" "\"sha\": \"${TARGET##*/}\"" "current target manifest matches its directory"
	assert_dir "$RELEASES/$SHA1" "first snapshot survived"
	assert_dir "$RELEASES/$SHA2" "second snapshot survived"
pass

# ==============================================================================
# T17: a checkout path with a newline must still produce a manifest the
# validator accepts (JSON escaping, no raw control character)

new_test "T17 newline in the source path"
EVIL_KIT="$SANDBOX/kit"$'\n'"line"
make_kit "$EVIL_KIT"
SHA="$(git -C "$EVIL_KIT" rev-parse HEAD)"
run_snapshot_at "$EVIL_KIT" "$RELEASES"
	assert_eq "$RC" 0 "snapshot of a checkout with a newline in its path"
MANIFEST="$RELEASES/$SHA/manifest.json"
	assert_file "$MANIFEST" "manifest"
	assert_eq "$(wc -l < "$MANIFEST" | tr -d ' ')" 7 "manifest has exactly the five fields"
WANT="${EVIL_KIT//$'\n'/\\n}"
	assert_eq "$(sed -n '6p' "$MANIFEST")" "  \"source\": \"$WANT\"" "source escaped as one line"
	if command -v python3 >/dev/null 2>&1; then
		if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MANIFEST" 2>/dev/null; then
			fail "manifest is not valid JSON"
		fi
	fi
# The strict validator is the real consumer: a second run must accept it.
run_snapshot_at "$EVIL_KIT" "$RELEASES"
	assert_eq "$RC" 0 "fast path accepts the escaped manifest"
	assert_contains "$OUT" "already present" "fast path reporting"
	assert_link "$RELEASES/current" "$SHA" "current points at the snapshot"
pass

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
