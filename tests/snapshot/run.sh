#!/usr/bin/env bash
#
# Snapshot CLI tests: `agent-kit snapshot <releases-dir>` manages the
# content-addressed release snapshots used by headless hosts.
#
# The writer is bin/lib/snapshot.mjs (Node.js); the CLI under test is the real
# bin/agent-kit dispatcher, pointed at a synthetic checkout through
# AGENT_KIT_ROOT. Every test runs in a fresh sandbox: a git checkout holding the
# snapshot inputs (extensions/ and node_modules/ with the four Pi runtime
# packages) and a separate releases directory. Nothing outside the sandbox is
# read or written except this repository's bin/.
#
# Contract this suite observes (the writer's own header documents the
# mechanisms):
#   * a snapshot is named by HEAD and built from the committed tree only - a
#     checkout with uncommitted or untracked changes is refused, and so is a
#     dirty artifact written by an older version;
#   * publication is atomic: a final name only ever holds a verified snapshot,
#     current only ever names one, and a failure leaves the old current alone;
#   * a repeated snapshot of the same commit is verified and reused, never
#     rewritten in place, and repairs current;
#   * node_modules is never hardlinked from the mutable checkout, extensions are
#     always a real copy;
#   * one exclusive lock per releases dir serializes build/flip/prune; takeover
#     requires a provably dead owner, never age;
#   * retention keeps current plus the five newest snapshots, and a directory
#     that cannot be removed is a warning, not a failure;
#   * no userland tool (cp, mv, stat, flock, pax, perl, tr, rm) is spawned.
#
# Usage: tests/snapshot/run.sh [-v]
#   -v  print snapshot output for each test
#
# Exit code: 0 when all tests pass, 1 otherwise.
set -euo pipefail

# The fixtures are self-contained: they must not inherit the host's git
# configuration (a global core.hooksPath or commit template would make the
# sandbox commits fail or behave differently on this machine).
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_REPO="$(cd "$SELF_DIR/.." && pwd -P)"
# The CLI under test. `snapshot` is implemented in-process by
# bin/lib/snapshot.mjs; there is no bridge process any more.
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
OUT=""
RC=0

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

assert_not_contains() { # <text> <fixed string> <what>
	case "$1" in
	*"$2"*) fail "$3: '$2' unexpectedly found in: $1" ;;
	*) : ;;
	esac
}

assert_bounded() { # <text> <max-lines> <what>
	local lines
	lines="$(printf '%s\n' "$1" | grep -c . || true)"
	if [ "$lines" -gt "$2" ]; then
		fail "$3: expected at most $2 output lines, got $lines: $1"
	fi
}

# --- portable userland helpers -----------------------------------------------
#
# The suite itself runs on GNU/Linux and on the BSD userland of macOS, so the
# platform-specific probes it needs live here (the CLI under test needs none of
# them).

file_inode() { # <path>
	stat -c %i -- "$1" 2>/dev/null || stat -f %i "$1"
}

file_nlink() { # <path>
	stat -c %h -- "$1" 2>/dev/null || stat -f %l "$1"
}

file_mtime() { # <path>
	stat -c %Y -- "$1" 2>/dev/null || stat -f %m "$1"
}

file_mode() { # <path>
	stat -c %a -- "$1" 2>/dev/null || stat -f %Lp "$1"
}

cp_archive() { # <src> <dst> — recursive copy preserving modes and links
	cp -a -- "$1" "$2" 2>/dev/null || cp -Rp "$1" "$2"
}

sed_inplace() { # <sed-script> <file> — GNU and BSD sed -i without a suffix
	local tmp="$2.sedtmp.$$"
	sed "$1" "$2" >"$tmp" || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$2"
}

insert_line_before() { # <file> <line-number> <text> — portable "<n>i" sed edit
	local tmp="$1.sedtmp.$$"
	awk -v n="$2" -v text="$3" 'NR == n { print text } { print }' "$1" >"$tmp" || \
		{ rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$1"
}

resolve_link() { # <link> — absolute physical target of a symlink
	local target
	target="$(readlink "$1")" || return 1
	case "$target" in
	/*) : ;;
	*) target="$(dirname "$1")/$target" ;;
	esac
	(cd "$target" 2>/dev/null && pwd -P)
}

# --- sandbox -----------------------------------------------------------------

new_test() { # <name>
	CURRENT="$1"
	FAIL_AT_START=$FAIL
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	[ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
	# A short base keeps sandbox paths inside the bounded diagnostic budget, so a
	# warning can still name the path it is about.
	if [ -d /tmp ] && [ -w /tmp ]; then
		SANDBOX="$(mktemp -d /tmp/agent-kit-snapshot.XXXXXX)"
	else
		SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-snapshot.XXXXXX")"
	fi
	SANDBOX="$(cd "$SANDBOX" && pwd -P)"
	KIT="$SANDBOX/kit"
	RELEASES="$SANDBOX/releases"
	unset AGENT_KIT_ROOT 2>/dev/null || true
	unset AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT 2>/dev/null || true
	unset AGENT_KIT_SNAPSHOT_FAIL_REMOVE 2>/dev/null || true
}

cleanup() {
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	[ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
}
trap cleanup EXIT

# Synthetic checkout: the snapshot inputs only. The checkout is git-initialized
# here because the snapshot identity is the commit, not the directory.
make_kit() { # <checkout-dir>
	local d="$1"
	mkdir -p "$d/extensions/alpha" "$d/extensions/subagents" \
		"$d/node_modules/@earendil-works/pi-coding-agent/dist" \
		"$d/node_modules/@earendil-works/pi-ai" \
		"$d/node_modules/@earendil-works/pi-tui" \
		"$d/node_modules/typebox"
	printf 'export const alpha = 1\n' >"$d/extensions/alpha/index.ts"
	printf 'export const subagents = 1\n' >"$d/$EXT_MARKER"
	printf 'export const pkg = "pi-coding-agent"\n' >"$d/$PKG_REL"
	printf 'export const pkg = "pi-ai"\n' >"$d/node_modules/@earendil-works/pi-ai/index.js"
	printf 'export const pkg = "pi-tui"\n' >"$d/node_modules/@earendil-works/pi-tui/index.js"
	printf 'export const pkg = "typebox"\n' >"$d/node_modules/typebox/index.js"
	printf 'node_modules\n' >"$d/.gitignore"
	git -C "$d" init -q
	git_commit_all "$d" "initial"
}

git_commit_all() { # <repo> <message> — commit every change with a fixed identity
	git -C "$1" add -A
	git -C "$1" -c user.email=agent-kit@test -c user.name=agent-kit commit -qm "$2"
}

head_sha() { # [<repo>] — full HEAD sha of the sandbox checkout
	git -C "${1:-$KIT}" rev-parse HEAD
}

run_snapshot_at() { # <root> <releases-dir> — sets OUT and RC
	if OUT="$(AGENT_KIT_ROOT="$1" "$INSTALLER" snapshot "$2" 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

run_snapshot() { # sets OUT and RC for the sandbox checkout
	run_snapshot_at "$KIT" "$RELEASES"
}

tmp_dirs() { # leftover .tmp-* entries in the releases dir (globs, no find(1))
	local p n=0
	for p in "$RELEASES"/.tmp-*; do
		if [ -e "$p" ] || [ -L "$p" ]; then
			n=$((n + 1))
		fi
	done
	printf '%s' "$n"
}

current_tmp_links() { # leftover .current.tmp-* entries in the releases dir
	local p n=0
	for p in "$RELEASES"/.current.tmp-*; do
		if [ -e "$p" ] || [ -L "$p" ]; then
			n=$((n + 1))
		fi
	done
	printf '%s' "$n"
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

fake_snapshot() { # <n> <touch-t-stamp> — a retention candidate with a 40-hex name
	local name
	name="$(printf '%040d' "$1")"
	mkdir -p "$RELEASES/$name"
	printf '{}\n' >"$RELEASES/$name/manifest.json"
	# touch -t has the same YYYYMMDDhhmm.SS syntax on GNU and BSD; -d does not.
	touch -t "$2" "$RELEASES/$name"
}

# A lock record exactly as the writer encodes it, so the tests can plant the
# lock states another process would leave behind.
lock_record() { # <pid> <host> — a lock symlink record
	printf '{"pid":%s,"host":"%s","token":"planted","started":1}' "$1" "$2"
}

host_name() {
	node -e 'process.stdout.write(require("node:os").hostname())'
}

dead_pid() { # a pid that existed and is now gone, so the owner is provably dead
	local pid
	sleep 30 &
	pid=$!
	kill -9 "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	printf '%s' "$pid"
}

wait_for_releases_entry() { # <prefix> — bounded wait for a top-level releases entry
	local i=0 p
	while [ "$i" -lt 4000 ]; do
		for p in "$RELEASES"/"$1"*; do
			if [ -e "$p" ] || [ -L "$p" ]; then
				return 0
			fi
		done
		sleep 0.005
		i=$((i + 1))
	done
	return 1
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
	assert_dir "$RELEASES/$SHA/node_modules/@earendil-works/pi-ai" "runtime package copied"
	assert_link "$RELEASES/current" "$SHA" "current symlink"
	assert_file "$RELEASES/current/manifest.json" "current resolves to a complete snapshot"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
	assert_eq "$(snapshot_dirs)" 1 "exactly one snapshot"
	assert_no_file "$RELEASES/.lock" "the lock is released"
pass

# ==============================================================================
# T2: the fast path copies nothing, leaves the snapshot untouched, and still
# repairs a current symlink that points elsewhere

new_test "T2 fast path is a no-op"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
EXT_INODE="$(file_inode "$RELEASES/$SHA/extensions/alpha/index.ts")"
MANIFEST_INODE="$(file_inode "$RELEASES/$SHA/manifest.json")"
DIR_MTIME="$(file_mtime "$RELEASES/$SHA")"
# Point current away from the existing snapshot: the fast path must flip it back
# instead of copying again.
ln -sfn "$(printf '%040d' 0)" "$RELEASES/current"
run_snapshot
	assert_eq "$RC" 0 "second snapshot"
	assert_contains "$OUT" "already present" "fast path reporting"
	assert_link "$RELEASES/current" "$SHA" "current repaired"
	assert_eq "$(file_inode "$RELEASES/$SHA/extensions/alpha/index.ts")" "$EXT_INODE" "extensions not copied"
	assert_eq "$(file_inode "$RELEASES/$SHA/manifest.json")" "$MANIFEST_INODE" "manifest not rewritten"
	assert_eq "$(file_mtime "$RELEASES/$SHA")" "$DIR_MTIME" "snapshot dir untouched"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T3: a dirty checkout is refused (the old writer snapshotted it under the HEAD
# sha and flagged it in the manifest; that identity is gone), and a dirty
# artifact written by an older version is never reused or relabelled

new_test "T3 dirty tree is refused"
make_kit "$KIT"
SHA="$(head_sha)"
printf '\n// dirty change\n' >>"$KIT/extensions/alpha/index.ts"
run_snapshot
	assert_eq "$RC" 2 "a modified tracked file is refused"
	assert_contains "$OUT" "uncommitted" "diagnostic names the contract"
	assert_contains "$OUT" "commit or stash" "diagnostic says what to do"
	assert_contains "$OUT" "extensions/alpha/index.ts" "diagnostic names the path"
	assert_no_file "$RELEASES/$SHA" "nothing published for a dirty tree"
	assert_no_file "$RELEASES/current" "current is not created for a dirty tree"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
printf 'notes\n' >"$KIT/notes.txt"
run_snapshot
	assert_eq "$RC" 2 "an untracked file is refused"
	assert_contains "$OUT" "notes.txt" "diagnostic names the untracked file"
rm -f "$KIT/notes.txt"
git_commit_all "$KIT" "dirty change"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "a clean tree snapshots"
	assert_grep "$RELEASES/$SHA/manifest.json" '"dirty": false' "clean flag"
assert_not_contains "$(cat "$RELEASES/$SHA/manifest.json")" 'dirty change' "content is the commit"

# A dirty artifact of the older writer, planted under a clean HEAD sha of its
# own: it must be refused with diagnostics, not accepted as this commit.
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
cp_archive "$RELEASES/$SHA" "$RELEASES/$SHA2"
sed_inplace "s/$SHA/$SHA2/" "$RELEASES/$SHA2/manifest.json"
sed_inplace 's/"dirty": false/"dirty": true/' "$RELEASES/$SHA2/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "a legacy dirty artifact is refused"
	assert_contains "$OUT" "not a complete snapshot" "legacy artifact diagnostic"
	assert_contains "$OUT" "dirty working tree" "legacy artifact reason"
	assert_link "$RELEASES/current" "$SHA" "current untouched by the refusal"
pass

# ==============================================================================
# T4: node_modules is hardlinked from the previous current only; the checkout's
# own node_modules is copied (a hardlink would let a later checkout change
# mutate a published snapshot), and extensions are always a real copy
#
# The checkout file is replaced with a NEW inode before the second run:
# otherwise "the same inode" would hold even if the second snapshot copied from
# the checkout instead of the previous current.

new_test "T4 copy on first sync, hardlink only between snapshots"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
INODE1="$(file_inode "$RELEASES/$SHA1/$PKG_REL")"
	if [ "$(file_inode "$KIT/$PKG_REL")" = "$INODE1" ]; then
		fail "the first snapshot must copy the checkout's node_modules, not hardlink it"
	fi
	assert_eq "$(file_nlink "$RELEASES/$SHA1/$PKG_REL")" 1 "the checkout keeps its own inode"
printf 'export const pkg = "pi-coding-agent-v2"\n' >"$KIT/$PKG_REL.new"
mv -f "$KIT/$PKG_REL.new" "$KIT/$PKG_REL"
	if [ "$(file_inode "$KIT/$PKG_REL")" = "$INODE1" ]; then
		fail "test setup: the checkout file must have a new inode"
	fi
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "second snapshot"
	assert_eq "$(file_inode "$RELEASES/$SHA2/$PKG_REL")" "$INODE1" "node_modules hardlinked from the previous snapshot, not from the checkout"
	assert_grep "$RELEASES/$SHA2/$PKG_REL" 'pi-coding-agent"' "previous snapshot content, not the checkout's new content"
	assert_eq "$(file_nlink "$RELEASES/$SHA2/$PKG_REL")" 2 "the two snapshots share the inode"
	if [ "$(file_inode "$RELEASES/$SHA1/extensions/alpha/index.ts")" = \
		"$(file_inode "$RELEASES/$SHA2/extensions/alpha/index.ts")" ]; then
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
	fake_snapshot "$i" "2020010${i}0000.00"
	i=$((i + 1))
done
run_snapshot
	assert_eq "$RC" 0 "fast path with retention"
	assert_link "$RELEASES/current" "$SHA1" "current kept"
	assert_no_file "$RELEASES/$(printf '%040d' 1)" "oldest candidate pruned"
	assert_dir "$RELEASES/$(printf '%040d' 2)" "newest candidates kept"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
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
# T6: detached HEAD, non-git checkouts and argument errors are refused without
# touching current

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
mkdir -p "$SANDBOX/plain"
run_snapshot_at "$SANDBOX/plain" "$RELEASES"
	assert_eq "$RC" 2 "non-git checkout refused"
	assert_contains "$OUT" "not a git checkout" "non-git message"
	assert_link "$RELEASES/current" "$SHA" "current untouched"
if OUT="$(AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 2 "missing releases-dir argument refused"
	assert_contains "$OUT" "exactly one argument" "argument message"
if OUT="$(AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" extra 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 2 "a second argument is refused"
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
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# A dangling symlink in the previous snapshot cannot be hardlinked into the new
# node_modules, so the materialization fails after extensions were copied.
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 2 "materialization failure"
	assert_contains "$OUT" "cannot link" "bounded failure message"
	assert_bounded "$OUT" 3 "failure output"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_no_file "$RELEASES/$SHA2" "no final dir for the failed snapshot"
	assert_eq "$(tmp_dirs)" 0 "temp dir cleaned"
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds"
	assert_link "$RELEASES/current" "$SHA2" "current advanced after recovery"
pass

# ==============================================================================
# T8: an existing final name is never overwritten, whatever it is

new_test "T8 existing final name is not overwritten"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
mkdir "$RELEASES/$SHA2"
run_snapshot
	assert_eq "$RC" 2 "incomplete existing dir refused"
	assert_contains "$OUT" "not a complete snapshot" "conflict message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_eq "$(tmp_dirs)" 0 "temp dir cleaned"
rmdir "$RELEASES/$SHA2"
# rename(2) would replace a file or a symlink at the target silently, so the
# type of the existing path is part of the refusal.
printf 'not a snapshot\n' >"$RELEASES/$SHA2"
run_snapshot
	assert_eq "$RC" 2 "a file under the final name is refused"
	assert_contains "$OUT" "not a directory" "type-aware conflict message"
	assert_eq "$(cat "$RELEASES/$SHA2")" "not a snapshot" "the file was not replaced"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
pass

# ==============================================================================
# T9: current resolves at every observed moment while a new snapshot is built

new_test "T9 current never dangles"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
(
	if AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out" 2>&1; then
		printf 0 >"$SANDBOX/rc"
	else
		printf '%s' "$?" >"$SANDBOX/rc"
	fi
) &
PID=$!
BROKEN=0
while kill -0 "$PID" 2>/dev/null; do
	if [ ! -f "$RELEASES/current/manifest.json" ] || [ ! -f "$RELEASES/current/$EXT_MARKER" ]; then
		# A long-running process on APFS (macOS 14.8) can report a transient
		# ENOENT for a path that a bare rename(2) just replaced, so a single
		# in-process observation is not trusted. A real dangle persists for far
		# longer than one rename, so a fresh process settles it.
		if ! /bin/sh -c 'test -f "$1/manifest.json" && test -f "$1/$2"' sh \
			"$RELEASES/current" "$EXT_MARKER" 2>/dev/null; then
			BROKEN=1
		fi
	fi
done
wait "$PID" || true
	assert_eq "$(cat "$SANDBOX/rc")" 0 "snapshot exit code"
	assert_eq "$BROKEN" 0 "current always resolved during the run"
	assert_link "$RELEASES/current" "$SHA2" "current flipped after completion"
	assert_eq "$(current_tmp_links)" 0 "no temporary current link left behind"
pass

# ==============================================================================
# T10: help text documents the subcommand and its identity contract

new_test "T10 help text"
OUT="$("$INSTALLER" help 2>&1)"
	assert_contains "$OUT" "agent-kit snapshot <releases-dir>" "help usage"
	assert_contains "$OUT" "current" "help current contract"
	assert_contains "$OUT" "uncommitted" "help states the clean-checkout contract"
	assert_not_contains "$OUT" "flock" "help no longer documents a flock path"
pass

# ==============================================================================
# T11: a same-named directory is only trusted after a strict completeness check;
# an incomplete artifact is refused instead of being flipped to

new_test "T11 incomplete artifacts are refused"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# (a) empty payload plus a text file that happens to contain the sha: a
# grep-based fast path would accept and flip to it.
mkdir -p "$RELEASES/$SHA2/extensions" "$RELEASES/$SHA2/node_modules"
printf 'a text file mentioning "sha": "%s"\n' "$SHA2" >"$RELEASES/$SHA2/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "text manifest refused"
	assert_contains "$OUT" "not a complete snapshot" "text manifest message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the text manifest"
# (b) a structurally valid manifest over an empty payload
cp "$RELEASES/$SHA1/manifest.json" "$RELEASES/$SHA2/manifest.json"
sed_inplace "s/$SHA1/$SHA2/" "$RELEASES/$SHA2/manifest.json"
run_snapshot
	assert_eq "$RC" 2 "empty payload refused"
	assert_contains "$OUT" "not a complete snapshot" "empty payload message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the empty payload"
# (c) a complete copy that lacks a runtime package, and (d) one that lacks the
# extensions marker, are both refused as artifacts of another sha
printf '\n// third\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "third"
SHA3="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "third snapshot"
printf '\n// fourth\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "fourth"
SHA4="$(head_sha)"
rm -rf "$RELEASES/$SHA2"
mkdir "$RELEASES/$SHA4"
cp_archive "$RELEASES/$SHA3/." "$RELEASES/$SHA4/"
sed_inplace "s/$SHA3/$SHA4/" "$RELEASES/$SHA4/manifest.json"
rm -rf "$RELEASES/$SHA4/node_modules/typebox"
run_snapshot
	assert_eq "$RC" 2 "missing runtime package refused"
	assert_contains "$OUT" "not a complete snapshot" "missing package message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the missing package"
cp_archive "$RELEASES/$SHA3/node_modules/typebox" "$RELEASES/$SHA4/node_modules/typebox"
rm -rf "$RELEASES/$SHA4/extensions/subagents"
run_snapshot
	assert_eq "$RC" 2 "missing extensions marker refused"
	assert_contains "$OUT" "not a complete snapshot" "missing marker message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the missing marker"
# (e) a manifest with an unexpected field is not one of ours
mkdir -p "$RELEASES/$SHA4/extensions/subagents"
printf 'export const subagents = 1\n' >"$RELEASES/$SHA4/$EXT_MARKER"
insert_line_before "$RELEASES/$SHA4/manifest.json" 4 '  "extra": 1,'
run_snapshot
	assert_eq "$RC" 2 "extra manifest field refused"
	assert_contains "$OUT" "not a complete snapshot" "extra field message"
	assert_link "$RELEASES/current" "$SHA3" "current untouched by the extra field"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T12: a 0555 source directory keeps its mode in the snapshot, and a failed
# materialization still removes a temp tree that holds such a directory

new_test "T12 a 0555 temp tree is removable"
make_kit "$KIT"
mkdir "$KIT/extensions/locked"
printf 'locked\n' >"$KIT/extensions/locked/inside.txt"
chmod 0555 "$KIT/extensions/locked"
git_commit_all "$KIT" "locked dir"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot with a 0555 source dir"
	assert_file "$RELEASES/$SHA1/extensions/locked/inside.txt" "0555 dir copied"
	assert_eq "$(file_mode "$RELEASES/$SHA1/extensions/locked")" 555 "the copied directory keeps its mode"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# The extensions copy (with the 0555 directory) succeeds, then the node_modules
# hardlink copy fails: the temp tree holds a directory that cannot be descended
# into without relaxing permissions first.
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 2 "materialization failure"
	assert_no_file "$RELEASES/$SHA2" "no final dir for the failed snapshot"
	assert_eq "$(tmp_dirs)" 0 "0555 temp tree removed"
	assert_link "$RELEASES/current" "$SHA1" "current untouched"
	assert_not_contains "$OUT" "could not remove the temporary directory" "no cleanup warning"
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds"
pass

# ==============================================================================
# T13: when the temp tree cannot be removed at all, cleanup reports exactly one
# bounded warning naming it instead of failing silently

new_test "T13 unremovable temp dir warns once"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >>"$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
AGENT_KIT_SNAPSHOT_FAIL_REMOVE=".tmp-" run_snapshot
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
# The next run adopts the releases dir (the lock of the failed run is gone) and
# sweeps the leftover temporary tree.
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds"
	assert_eq "$(tmp_dirs)" 0 "the leftover temp dir was swept"
	assert_link "$RELEASES/current" "$SHA2" "current advanced"
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
while [ "$i" -le 8 ]; do
	fake_snapshot "$i" "2020010${i}0000.00"
	i=$((i + 1))
done
OLD="$(printf '%040d' 1)"
AGENT_KIT_SNAPSHOT_FAIL_REMOVE="$OLD" run_snapshot
	assert_eq "$RC" 0 "a prune failure keeps exit 0"
	assert_link "$RELEASES/current" "$SHA" "current still on the snapshot of HEAD"
	assert_dir "$RELEASES/$OLD" "the undeletable directory stays"
	assert_eq "$(printf '%s\n' "$OUT" | grep -c 'could not remove the old snapshot' || true)" 1 "exactly one prune warning"
WARNING="$(printf '%s\n' "$OUT" | grep 'could not remove the old snapshot' || true)"
	assert_contains "$WARNING" "$OLD" "warning names the failing directory"
	if [ "${#WARNING}" -gt 300 ]; then
		fail "prune warning must stay bounded, got ${#WARNING} chars"
	fi
	assert_no_file "$RELEASES/$(printf '%040d' 2)" "pruning continued past the failure"
	assert_no_file "$RELEASES/$(printf '%040d' 3)" "pruning continued to the last candidate"
	assert_dir "$RELEASES/$(printf '%040d' 4)" "newest candidates kept"
	assert_dir "$RELEASES/$(printf '%040d' 8)" "the newest candidate is kept"
	assert_eq "$(snapshot_dirs)" 7 "current plus five newest plus the undeletable one"
pass

# ==============================================================================
# T15: the releases lock is exclusive, bounded, and recoverable
#
# A lock is taken over only when its recorded owner is provably gone (same host,
# pid no longer exists). A live owner keeps its lock whatever the age, and a
# lock that cannot be attributed is a bounded error naming the owner.

new_test "T15 lock: bounded wait, owner-based takeover"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
HOST="$(host_name)"
# (a) a live owner keeps its lock: the otherwise instant fast path waits, then
# fails with a bounded message instead of stealing the lock.
sleep 5 &
LIVE=$!
ln -s "$(lock_record "$LIVE" "$HOST")" "$RELEASES/.lock"
AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=1 run_snapshot
	assert_eq "$RC" 2 "a live lock times out"
	assert_contains "$OUT" "another snapshot is running as pid $LIVE" "message names the owner"
	assert_bounded "$OUT" 2 "lock timeout output"
	assert_link "$RELEASES/current" "$SHA" "current untouched on lock timeout"
	assert_link "$RELEASES/.lock" "$(lock_record "$LIVE" "$HOST")" "the live lock was not displaced"
kill -9 "$LIVE" 2>/dev/null || true
wait "$LIVE" 2>/dev/null || true
# (b) the same lock, now with a dead owner, is taken over and the run completes.
run_snapshot
	assert_eq "$RC" 0 "a provably dead owner is taken over"
	assert_contains "$OUT" "already present" "the fast path ran under the new lock"
	assert_no_file "$RELEASES/.lock" "the lock is released"
	assert_link "$RELEASES/current" "$SHA" "current intact"
# (c) a lock of another host cannot be attributed, so it is never taken over.
ln -s "$(lock_record 999999 "another-host.invalid")" "$RELEASES/.lock"
AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=1 run_snapshot
	assert_eq "$RC" 2 "a foreign lock is a bounded error"
	assert_contains "$OUT" "another-host.invalid" "message names the owner host"
rm -f "$RELEASES/.lock"
# (d) a lock with no readable owner record is a bounded error, not a steal.
ln -s "not-an-agent-kit-lock" "$RELEASES/.lock"
AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=1 run_snapshot
	assert_eq "$RC" 2 "an unattributable lock is refused"
	assert_contains "$OUT" "no readable owner record" "message names the condition"
rm -f "$RELEASES/.lock"
# (e) the flock file of the pre-Node writer carries no owner record; it is a
# leftover, removed once with a warning.
: >"$RELEASES/.lock"
run_snapshot
	assert_eq "$RC" 0 "a legacy lock file does not block the command"
	assert_contains "$OUT" "legacy lock file" "legacy artifact is reported"
	assert_no_file "$RELEASES/.lock" "the legacy file was removed"
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
cp_archive "$KIT" "$SANDBOX/kit2"
printf '\n// second checkout\n' >>"$SANDBOX/kit2/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit2" "second"
SHA2="$(git -C "$SANDBOX/kit2" rev-parse HEAD)"
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020010${i}0000.00"
	i=$((i + 1))
done
: >"$SANDBOX/watch"
(
	while [ ! -f "$SANDBOX/stop-watch" ]; do
		if [ ! -f "$RELEASES/current/$EXT_MARKER" ] || [ ! -f "$RELEASES/current/manifest.json" ]; then
			printf 'dangling\n' >>"$SANDBOX/watch"
		fi
		sleep 0.01
	done
) &
WATCHER=$!
(if AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >/dev/null 2>"$SANDBOX/err-old"; then printf 0 >"$SANDBOX/rc-old"; else printf '%s' "$?" >"$SANDBOX/rc-old"; fi) &
P1=$!
(if AGENT_KIT_ROOT="$SANDBOX/kit2" "$INSTALLER" snapshot "$RELEASES" >/dev/null 2>"$SANDBOX/err-new"; then printf 0 >"$SANDBOX/rc-new"; else printf '%s' "$?" >"$SANDBOX/rc-new"; fi) &
P2=$!
wait "$P1" || true
wait "$P2" || true
touch "$SANDBOX/stop-watch"
wait "$WATCHER" || true
	assert_eq "$(cat "$SANDBOX/rc-old")" 0 "fast-path process exit code"
	assert_eq "$(cat "$SANDBOX/rc-new")" 0 "materializing process exit code"
	assert_eq "$(wc -l <"$SANDBOX/watch" | tr -d ' ')" 0 "current never dangled"
TARGET="$(resolve_link "$RELEASES/current" || true)"
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
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
	assert_no_file "$RELEASES/.lock" "the lock is released"
pass

# ==============================================================================
# T17: a checkout path with a newline must still produce a manifest the strict
# validator accepts (JSON escaping, no raw control character)

new_test "T17 newline in the source path"
EVIL_KIT="$SANDBOX/kit"$'\n'"line"
make_kit "$EVIL_KIT"
SHA="$(head_sha "$EVIL_KIT")"
run_snapshot_at "$EVIL_KIT" "$RELEASES"
	assert_eq "$RC" 0 "snapshot of a checkout with a newline in its path"
MANIFEST="$RELEASES/$SHA/manifest.json"
	assert_file "$MANIFEST" "manifest"
	assert_eq "$(wc -l <"$MANIFEST" | tr -d ' ')" 7 "manifest has exactly the five fields"
WANT="${EVIL_KIT//$'\n'/\\n}"
	assert_eq "$(sed -n '6p' "$MANIFEST")" "  \"source\": \"$WANT\"" "source escaped as one line"
	if command -v python3 >/dev/null 2>&1; then
		if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MANIFEST" 2>/dev/null; then
			fail "manifest is not valid JSON"
		fi
	fi
# The strict validator is the real consumer: a second run must accept it.
run_snapshot_at "$EVIL_KIT" "$RELEASES"
	assert_eq "$RC" 0 "the manifest validates on the next run"
	assert_contains "$OUT" "already present" "fast path accepted the escaped manifest"
pass

# ==============================================================================
# T18: the writer spawns no userland tool. Every name in the trap directory
# fails loudly, so a single call proves the dependency: the command must still
# succeed, because publication is Node filesystem calls only (git decides the
# checkout identity, and the traps deliberately leave git and node alone).
#
# The pre-Node writer needed cp, pax, mv, perl, stat, tr, flock and date; this
# test is the regression bar for reintroducing one of them.

new_test "T18 no external userland tools"
make_kit "$KIT"
SHA="$(head_sha)"
TRAPS="$SANDBOX/trap-bin"
mkdir -p "$TRAPS"
for tool in cp mv rm ln chmod stat flock pax perl tr sed cat date touch find mkdir rmdir; do
	{
		printf '#!/bin/sh\n'
		printf 'printf "%%s\\n" %q >>%q\n' "$tool" "$SANDBOX/tool-calls"
		printf 'exit 1\n'
	} >"$TRAPS/$tool"
	chmod +x "$TRAPS/$tool"
done
: >"$SANDBOX/tool-calls"
if OUT="$(PATH="$TRAPS:$PATH" AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "the snapshot succeeds with every userland tool trapped"
	assert_link "$RELEASES/current" "$SHA" "current flipped"
	if [ -s "$SANDBOX/tool-calls" ]; then
		fail "the writer spawned a userland tool: $(tr '\n' ' ' <"$SANDBOX/tool-calls")"
	fi
pass

# ==============================================================================
# T19: retention orders candidates by mtime, not by name

new_test "T19 retention sorts by mtime"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
# The names ascend while the timestamps descend: a name-ordered prune would drop
# the wrong directory.
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020010$((7 - i))0000.00"
	i=$((i + 1))
done
run_snapshot
	assert_eq "$RC" 0 "fast path with retention"
	assert_no_file "$RELEASES/$(printf '%040d' 6)" "the oldest candidate by mtime is pruned"
	assert_dir "$RELEASES/$(printf '%040d' 1)" "the newest candidate by mtime is kept"
	assert_dir "$RELEASES/$(printf '%040d' 2)" "the second newest candidate is kept"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
pass

# ==============================================================================
# T20: SIGKILL during the copy. The killed run leaves a temporary tree and the
# lock of a dead owner; the next run takes the lock over, sweeps the leftovers,
# and publishes without touching the previous current.

new_test "T20 SIGKILL during the copy"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
# Extensions are always copied for real, so a large extensions tree keeps the
# build in flight long enough to be seen and stopped; node_modules would be
# hardlinked from the previous snapshot in milliseconds.
mkdir -p "$KIT/extensions/bulk"
i=0
while [ "$i" -lt 20000 ]; do
	printf 'export const n = %s\n' "$i" >"$KIT/extensions/bulk/f$i.js"
	i=$((i + 1))
done
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# The installer runs as a direct background child, so $! is the process that is
# killed for real (a wrapper subshell would take the signal instead). The build
# is frozen the moment its temporary tree appears, so the kill is deterministic
# instead of a race against the copy.
AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out" 2>&1 &
KILLED=$!
if ! wait_for_releases_entry ".tmp-"; then
	fail "test setup: the copy finished before it could be killed"
fi
kill -STOP "$KILLED" 2>/dev/null || true
if [ "$(tmp_dirs)" -eq 0 ]; then
	fail "test setup: the build left no temporary tree to inspect"
fi
kill -9 "$KILLED" 2>/dev/null || true
wait "$KILLED" 2>/dev/null || true
	if [ "$(tmp_dirs)" -eq 0 ]; then
		fail "test setup: expected a leftover temporary tree after the kill"
	fi
	assert_no_file "$RELEASES/$SHA2" "the killed run published nothing"
	assert_link "$RELEASES/current" "$SHA1" "current still names the previous snapshot"
	assert_link_exists=0
	if [ -L "$RELEASES/.lock" ]; then assert_link_exists=1; fi
	assert_eq "$assert_link_exists" 1 "the killed run left the lock of a dead owner"
run_snapshot
	assert_eq "$RC" 0 "the next run recovers"
	assert_contains "$OUT" "current" "recovery report"
	assert_eq "$(tmp_dirs)" 0 "the leftover temporary tree was swept"
	assert_no_file "$RELEASES/.lock" "the lock was taken over and released"
	assert_link "$RELEASES/current" "$SHA2" "current advanced after recovery"
	assert_file "$RELEASES/$SHA2/manifest.json" "the recovered snapshot is complete"
pass

# ==============================================================================
# T21: the residue of a kill between the publish rename and the flip — a
# complete snapshot directory with no current. The next run verifies it, does
# not rewrite it, and only flips current.

new_test "T21 kill between publish and flip is repaired"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
TARGET="$(resolve_link "$RELEASES/current")"
MANIFEST_INODE="$(file_inode "$TARGET/manifest.json")"
DIR_MTIME="$(file_mtime "$TARGET")"
# Exactly what the kill leaves: the published directory, no current.
rm -f "$RELEASES/current"
run_snapshot
	assert_eq "$RC" 0 "the next run repairs current"
	assert_contains "$OUT" "already present" "the published snapshot is reused"
	assert_link "$RELEASES/current" "$SHA" "current repaired"
	assert_eq "$(file_inode "$TARGET/manifest.json")" "$MANIFEST_INODE" "the snapshot was not rewritten"
	assert_eq "$(file_mtime "$TARGET")" "$DIR_MTIME" "the snapshot directory was not touched"
pass

# ==============================================================================
# T22: the residue of a kill after the flip and before the prune. The next run
# prunes to the documented number and never removes current's target.

new_test "T22 kill after flip is repaired by the next prune"
make_kit "$KIT"
SHA="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
i=1
while [ "$i" -le 9 ]; do
	fake_snapshot "$i" "2020010$((i % 10))0000.00"
	i=$((i + 1))
done
run_snapshot
	assert_eq "$RC" 0 "the fast path prunes"
	assert_link "$RELEASES/current" "$SHA" "current still on the snapshot of HEAD"
	assert_dir "$RELEASES/$SHA" "current's target was not pruned"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
	assert_no_file "$RELEASES/$(printf '%040d' 1)" "oldest candidate pruned"
pass

# ==============================================================================
# T23: four real processes on one releases dir. The lock serializes them; every
# process either refuses boundedly or succeeds, current ends on a complete
# snapshot, and no lock, temp tree or temporary link survives.

new_test "T23 four concurrent processes share one releases dir"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
i=2
while [ "$i" -le 4 ]; do
	cp_archive "$KIT" "$SANDBOX/kit$i"
	printf '\n// checkout %s\n' "$i" >>"$SANDBOX/kit$i/extensions/alpha/index.ts"
	git_commit_all "$SANDBOX/kit$i" "checkout $i"
	i=$((i + 1))
done
PIDLIST=""
for root in "$KIT" "$SANDBOX/kit2" "$SANDBOX/kit3" "$SANDBOX/kit4"; do
	(if AGENT_KIT_ROOT="$root" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out-$(basename "$root")" 2>&1; then
		printf 0 >"$SANDBOX/rc-$(basename "$root")"
	else
		printf '%s' "$?" >"$SANDBOX/rc-$(basename "$root")"
	fi) &
	PIDLIST="$PIDLIST $!"
done
for pid in $PIDLIST; do wait "$pid" || true; done
for root in "$KIT" "$SANDBOX/kit2" "$SANDBOX/kit3" "$SANDBOX/kit4"; do
	name="$(basename "$root")"
	assert_eq "$(cat "$SANDBOX/rc-$name")" 0 "$name exit code"
done
TARGET="$(resolve_link "$RELEASES/current" || true)"
	[ -n "$TARGET" ] || fail "current does not resolve after four runs"
	assert_file "$TARGET/manifest.json" "current target has a manifest"
	assert_grep "$TARGET/manifest.json" "\"sha\": \"${TARGET##*/}\"" "current target matches its directory"
	assert_dir "$TARGET/node_modules/typebox" "current target has node_modules"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
	assert_eq "$(current_tmp_links)" 0 "no temporary current link left behind"
	assert_no_file "$RELEASES/.lock" "the lock is released"
pass

# ==============================================================================
# T24: SIGTERM mid-build is a hard stop, exactly like SIGKILL: the previous
# current stays untouched, the temporary tree and the dead owner's lock remain,
# and the next run adopts the releases dir. (Node cannot service a signal handler
# while the synchronous copy holds the stack, so the writer installs none and the
# default disposition ends the process immediately.)

new_test "T24 SIGTERM is a hard stop the next run recovers from"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
mkdir -p "$KIT/extensions/bulk"
i=0
while [ "$i" -lt 20000 ]; do
	printf 'export const n = %s\n' "$i" >"$KIT/extensions/bulk/f$i.js"
	i=$((i + 1))
done
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" >"$SANDBOX/out" 2>&1 &
INTERRUPTED=$!
if ! wait_for_releases_entry ".tmp-"; then
	fail "test setup: the copy finished before it could be interrupted"
fi
kill -TERM "$INTERRUPTED" 2>/dev/null || true
TERM_STATUS=0
wait "$INTERRUPTED" 2>/dev/null || TERM_STATUS=$?
	assert_eq "$TERM_STATUS" 143 "the process died from SIGTERM"
	assert_no_file "$RELEASES/$SHA2" "the interrupted run published nothing"
	assert_link "$RELEASES/current" "$SHA1" "current still names the previous snapshot"
	if [ "$(tmp_dirs)" -eq 0 ]; then
		fail "test setup: expected the interrupted run to leave its temporary tree"
	fi
run_snapshot
	assert_eq "$RC" 0 "the next run succeeds"
	assert_link "$RELEASES/current" "$SHA2" "current advanced"
pass

# ==============================================================================

[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
