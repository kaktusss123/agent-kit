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

# The fixtures are self-contained: they must not inherit the host's git
# configuration (a global core.hooksPath or commit template would make the
# sandbox commits fail or behave differently on this machine).
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

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

extract_function() { # <file> <name> — top-level function body, header included
	awk -v fn="$2" '
		$0 ~ "^" fn "\\(\\)" { inside = 1; print; next }
		inside && /^[A-Za-z_][A-Za-z0-9_]*\(\)/ { exit }
		inside { print }
	' "$1"
}

# --- portable userland helpers -----------------------------------------------
#
# The suite runs on GNU/Linux and on the BSD userland of macOS, so every
# platform-specific probe lives here: stat -c (GNU) versus stat -f (BSD), cp -a
# versus cp -Rp, readlink -f versus plain readlink, sed -i with and without a
# backup suffix.

file_inode() { # <path>
	stat -c %i -- "$1" 2>/dev/null || stat -f %i "$1"
}

file_nlink() { # <path>
	stat -c %h -- "$1" 2>/dev/null || stat -f %l "$1"
}

file_mtime() { # <path>
	stat -c %Y -- "$1" 2>/dev/null || stat -f %m "$1"
}

cp_archive() { # <src> <dst> — recursive copy preserving modes and links
	cp -a -- "$1" "$2" 2>/dev/null || cp -Rp "$1" "$2"
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

sed_inplace() { # <sed-script> <file> — GNU and BSD sed -i without a suffix
	local tmp="$2.sedtmp.$$"
	sed "$1" "$2" > "$tmp" || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$2"
}

insert_line_before() { # <file> <line-number> <text> — portable "<n>i" sed edit
	local tmp="$1.sedtmp.$$"
	awk -v n="$2" -v text="$3" 'NR == n { print text } { print }' "$1" > "$tmp" || \
		{ rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$1"
}

have_flock() { command -v flock >/dev/null 2>&1; }

have_perl() { command -v perl >/dev/null 2>&1; }

mv_has_T() { mv --help 2>&1 | grep -Fq -- 'no-target-directory'; }

# --- sandbox -----------------------------------------------------------------

new_test() { # <name>
	CURRENT="$1"
	FAIL_AT_START=$FAIL
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	[ -n "$SANDBOX" ] && rm -rf -- "$SANDBOX"
	# A short base keeps sandbox paths inside the bounded warning budget the
	# CLI promises (120 characters), so a warning can still name the path.
	if [ -d /tmp ] && [ -w /tmp ]; then
		SANDBOX="$(mktemp -d /tmp/agent-kit-snapshot.XXXXXX)"
	else
		SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-snapshot.XXXXXX")"
	fi
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

run_mkdir_snapshot() { # sets OUT and RC through the forced mkdir lock
	AGENT_KIT_SNAPSHOT_LOCK=mkdir run_snapshot
}

run_flock_snapshot() { # sets OUT and RC through the forced flock lock
	AGENT_KIT_SNAPSHOT_LOCK=flock run_snapshot
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

nested_temp_link() { # <dir> — a leftover .current.tmp-* link inside a snapshot
	local p
	for p in "$1"/.current.tmp-*; do
		if [ -e "$p" ] || [ -L "$p" ]; then
			printf '%s' "$p"
			return 0
		fi
	done
	return 0
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
	printf '{}\n' > "$RELEASES/$name/manifest.json"
	# touch -t has the same YYYYMMDDhhmm.SS syntax on GNU and BSD; -d does not.
	touch -t "$2" "$RELEASES/$name"
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

# --- stricter-userland shims -------------------------------------------------
#
# The BSD tools differ from GNU in a handful of flags. These shims refuse one
# such flag while delegating everything else to the real tool, so a single
# assertion proves the runtime never depends on it — on macOS and on Linux
# alike. Every call is logged, which is also how a test shows that a specific
# branch (pax, BSD stat) really ran instead of passing by luck.

make_flag_shim() { # <dir> <tool> <refused-arg> <log>
	local dir="$1" tool="$2" refused="$3" log="$4" real
	real="$(command -v "$tool")" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'refused=%q\n' "$refused"
		printf 'log=%q\n' "$log"
		cat <<'EOSH'
printf '%s\n' "$*" >> "$log"
for arg in "$@"; do
	if [ "$arg" = "$refused" ]; then
		printf '%s: illegal option: %s\n' "$0" "$arg" >&2
		exit 64
	fi
done
exec "$real" "$@"
EOSH
	} > "$dir/$tool"
	chmod +x "$dir/$tool"
}

make_fail_shim() { # <dir> <tool> — a tool that always fails
	local dir="$1" tool="$2"
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'printf "%%s: simulated failure\\n" "$0" >&2\n'
		printf 'exit 1\n'
	} > "$dir/$tool"
	chmod +x "$dir/$tool"
}

make_stub_tool() { # <dir> <tool> <log> — a tool that records its call, exits 0
	local dir="$1" tool="$2" log="$3"
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'printf "%%s\\n" "$*" >> %s\n' "$log"
		printf 'exit 0\n'
	} > "$dir/$tool"
	chmod +x "$dir/$tool"
}

emit_bsd_mv_exec() { # — tail of an mv shim: BSD-faithful flags, then the real tool
	# BSD mv rejects -T and reads -h as "replace the destination even when it is
	# a symlink to a directory". Forwarding a call such as `mv -fh` to the host
	# mv is wrong on GNU (mv has no -h), so the shim emulates the flag instead of
	# delegating it: the destination is unlinked and the rename runs with the
	# BSD-only flags stripped, which is exactly what BSD mv does. Shims that
	# forward platform-specific flags to the host tool must be correct on GNU and
	# on BSD hosts alike; T19 is the regression for this one.
	cat <<'EOSH'
has_h=0
op1=''
op2=''
for arg in "$@"; do
	case "$arg" in
	--*) : ;;
	-?*) case "$arg" in *h*) has_h=1 ;; esac ;;
	*)
		op1="$op2"
		op2="$arg"
		;;
	esac
done
if [ "$has_h" = 1 ]; then
	if [ -f "$op2" ] || [ -L "$op2" ]; then
		rm -f "$op2" || exit 1
	fi
	exec "$real" -f "$op1" "$op2"
fi
exec "$real" "$@"
EOSH
}

make_bsd_mv_shim() { # <dir> <log> — BSD mv: no -T, -h emulated, calls logged
	# GNU mv has -T; BSD mv rejects it as an illegal option, and plain mv nests
	# a directory into an existing one. The shim reproduces exactly that on any
	# host, emulates the -fh last resort (see emit_bsd_mv_exec) and records every
	# call, so a test can assert which rename tier really ran.
	local dir="$1" log="$2" real
	real="$(command -v mv)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'log=%q\n' "$log"
		cat <<'EOSH'
printf '%s\n' "$*" >> "$log"
for arg in "$@"; do
	case "$arg" in
	-*T*)
		printf '%s: illegal option -- T\n' "$0" >&2
		exit 64
		;;
	esac
done
EOSH
		emit_bsd_mv_exec
	} > "$dir/mv"
	chmod +x "$dir/mv"
}

mkdir_lock_write() { # <lock-dir> <age-seconds> — the mkdir lock of a holder
	# Mirrors what the CLI records: a pid and the acquisition stamp. An aged
	# stamp is what a SIGKILLed holder leaves behind.
	mkdir "$1" || return 1
	printf '99999\t%s\n' "$(( $(date +%s) - $2 ))" > "$1/owner"
}

release_lock_dir() { # <lock-dir> — the holder side of a mkdir lock
	rm -f "$1/owner" 2>/dev/null || true
	rmdir "$1" 2>/dev/null || true
}

# --- the CLI's mkdir-lock primitives, extracted verbatim ----------------------
#
# The stale-takeover race cannot be observed reliably from outside the CLI: the
# window is one rename. make_lock_harness extracts the real lock functions from
# the CLI into a standalone script so a test can drive an exact interleaving
# between two processes, which is how the takeover race was reproduced in
# review. The harness is only a driver: every lock primitive it calls is the
# code the CLI runs.

make_lock_harness() { # <out> — harness script with the CLI's mkdir-lock code
	local out="$1" fn
	{
		printf '#!/usr/bin/env bash\n'
		printf 'SNAPSHOT_STAT_STYLE=""\n'
		printf 'SNAPSHOT_LOCK_DIR=""\n'
		printf 'SNAPSHOT_LOCK_TOKEN=""\n'
		printf 'SNAPSHOT_LOCK_CLAIM=""\n'
		printf 'SNAPSHOT_LOCK_TIMEOUT="${AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT:-30}"\n'
		printf 'SNAPSHOT_LOCK_STALE="${AGENT_KIT_SNAPSHOT_LOCK_STALE:-600}"\n'
		printf 'warn() { printf "warning: %%s\\n" "$*" >&2; }\n'
		printf 'die() { printf "error: %%s\\n" "$*" >&2; exit 2; }\n'
		for fn in snapshot_bounded snapshot_remove_tree snapshot_make_writable \
			snapshot_stat_style snapshot_mtime snapshot_have_perl \
			snapshot_rename_dir snapshot_lock_owner_line snapshot_lock_age \
			snapshot_lock_takeover snapshot_lock_restore \
			snapshot_lock_claim_release snapshot_lock_mkdir snapshot_lock_held \
			snapshot_lock_verify snapshot_unlock; do
			extract_function "$INSTALLER" "$fn" || return 1
		done
		cat <<'EOSH'

mode="$1"; shift
case "$mode" in
lock) # <lock-dir> <oracle-dir> <hold-seconds> <log>
	snapshot_lock_mkdir "$1" || exit 3
	snapshot_lock_verify "the test hold"
	if mkdir "$2" 2>/dev/null; then
		printf 'hold %s\n' "$$" >> "$4"
	else
		printf 'overlap %s\n' "$$" >> "$4"
	fi
	sleep "$3"
	rmdir "$2" 2>/dev/null || true
	snapshot_unlock
	printf 'release %s\n' "$$" >> "$4"
	;;
verify) # <lock-dir> <log> — the lock disappears while it is held
	snapshot_lock_mkdir "$1" || exit 3
	printf 'ready\n' > "$2.ready"
	while [ ! -f "$2.go" ]; do sleep 0.05 2>/dev/null || sleep 1; done
	snapshot_lock_verify "the critical section"
	printf 'verify passed\n' >> "$2"
	snapshot_unlock
	;;
unlock) # <lock-dir> <log> — another process owns the lock when unlock runs
	snapshot_lock_mkdir "$1" || exit 3
	printf 'ready\n' > "$2.ready"
	while [ ! -f "$2.go" ]; do sleep 0.05 2>/dev/null || sleep 1; done
	snapshot_unlock
	printf 'unlock done\n' >> "$2"
	;;
takeover) # <lock-dir> <log> — one takeover attempt, result recorded
	if snapshot_lock_takeover "$1"; then
		printf 'takeover rc=0\n' >> "$2"
	else
		printf 'takeover rc=1\n' >> "$2"
	fi
	;;
*) printf 'unknown harness mode %s\n' "$mode" >&2; exit 64 ;;
esac
EOSH
	} > "$out"
	chmod +x "$out"
}

make_slow_takeover_mv_shim() { # <dir> — mv that waits before a stale-takeover move
	# Only the move of a stale lock aside is delayed, so a test can put a second
	# waiter's measured-as-stale move after the first waiter created its own
	# lock: that is the interleaving of the reviewer's reproduction. The source
	# is the second-to-last argument (mv is called as `mv -- <src> <dst>`).
	local dir="$1" real
	real="$(command -v mv)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		cat <<'EOSH'
src=''; last=''
for arg in "$@"; do
	src="$last"
	last="$arg"
done
case "$src" in
*.lock.d)
	case "$last" in
	*.stale-*) sleep "${MV_DELAY_S:-0}" ;;
	esac
	;;
esac
exec "$real" "$@"
EOSH
	} > "$dir/mv"
	chmod +x "$dir/mv"
}

make_pause_shim() { # <dir> <tool> <gate> <arg> — pause before the tool runs on <arg>
	# The pause sits in the tool call itself, which is exactly the interleaving a
	# reviewer produced with SIGSTOP: the CLI is frozen while another process
	# takes the releases dir over. <gate>.ready marks the pause, <gate>.go ends it.
	local dir="$1" tool="$2" gate="$3" match="$4" real
	real="$(command -v "$tool")" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'gate=%q\n' "$gate"
		printf 'match=%q\n' "$match"
		cat <<'EOSH'
for arg in "$@"; do
	if [ "$arg" = "$match" ]; then
		: > "$gate.ready"
		while [ ! -f "$gate.go" ]; do sleep 0.05 2>/dev/null || sleep 1; done
	fi
done
exec "$real" "$@"
EOSH
	} > "$dir/$tool"
	chmod +x "$dir/$tool"
}

make_pause_mv_shim() { # <dir> <gate> <src-prefix> — pause before that source is moved
	# mv is called as `mv -- <src> <dst>`, so the source is the second-to-last
	# argument. Matches the source by prefix: the release move and the takeover
	# move of a lock directory share the source name `.lock.d`.
	local dir="$1" gate="$2" prefix="$3" real
	real="$(command -v mv)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'gate=%q\n' "$gate"
		printf 'prefix=%q\n' "$prefix"
		cat <<'EOSH'
src=''
last=''
for arg in "$@"; do
	src="$last"
	last="$arg"
done
case "$src" in
"$prefix"*)
	: > "$gate.ready"
	while [ ! -f "$gate.go" ]; do sleep 0.05 2>/dev/null || sleep 1; done
	;;
esac
exec "$real" "$@"
EOSH
	} > "$dir/mv"
	chmod +x "$dir/mv"
}

make_fail_prefix_rm_shim() { # <dir> <prefix> — rm that fails for paths under <prefix>
	# Used to make a nested build unremovable, which is the branch where the CLI
	# has to name the tree that really exists instead of claiming a clean state.
	local dir="$1" prefix="$2" real
	real="$(command -v rm)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'prefix=%q\n' "$prefix"
		cat <<'EOSH'
for arg in "$@"; do
	case "$arg" in
	"$prefix"*)
		printf '%s: simulated removal failure\n' "$0" >&2
		exit 1
		;;
	esac
done
exec "$real" "$@"
EOSH
	} > "$dir/rm"
	chmod +x "$dir/rm"
}

make_publish_shim() { # <dir> <from> <final> <old-sha> <new-sha> <log> <mode> <refuse-T> [<fail-undo>]
	# Plants a complete snapshot of the new sha exactly at the publish rename,
	# which is what "a complete $final appeared while building $tmp" looks like
	# from inside the CLI. Mode `first` fires on the first move of the temp
	# directory, `plain` only on a move without a -T flag (the last-resort tier).
	# refuse-T=1 makes mv reject any -T flag cluster, exactly like BSD mv.
	# fail-undo=1 makes the undo move of a nested build fail, which is the
	# last-resort path whose failure must not leave a .tmp-* inside a published
	# snapshot.
	local dir="$1" real
	real="$(command -v mv)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'from=%q\n' "$2"
		printf 'final=%q\n' "$3"
		printf 'oldsha=%q\n' "$4"
		printf 'newsha=%q\n' "$5"
		printf 'log=%q\n' "$6"
		printf 'plant_mode=%q\n' "$7"
		printf 'refuse_t=%q\n' "$8"
		printf 'fail_undo=%q\n' "${9:-0}"
		cat <<'EOSH'
printf '%s\n' "$*" >> "$log"
src=''; last=''
for arg in "$@"; do
	src="$last"
	last="$arg"
done
has_t=0
for arg in "$@"; do
	case "$arg" in
	-*T*) has_t=1 ;;
	esac
done
if [ "$refuse_t" = 1 ] && [ "$has_t" = 1 ]; then
	printf '%s: illegal option -- T\n' "$0" >&2
	exit 64
fi
if [ "$fail_undo" = 1 ]; then
	for arg in "$@"; do
		case "$arg" in
		"$final"/.tmp-*)
			printf '%s: simulated undo failure\n' "$0" >&2
			exit 1
			;;
		esac
	done
fi
if [ ! -f "$log.planted" ]; then
	case "$src" in
	*/.tmp-*)
		if [ "$plant_mode" = first ] || [ "$has_t" = 0 ]; then
			: > "$log.planted"
			mkdir -p "$final" || exit 1
			cp -R "$from/." "$final/" || exit 1
			sed "s/$oldsha/$newsha/" "$from/manifest.json" > "$final/manifest.json" || exit 1
		fi
		;;
	esac
fi
EOSH
		emit_bsd_mv_exec
	} > "$dir/mv"
	chmod +x "$dir/mv"
}

make_swap_lock_mv_shim() { # <dir> <lock-dir> <new-owner-line>
	# Replaces the lock exactly while a takeover moves it aside, which is the
	# interleaving the second guard of the takeover has to survive: the moved
	# directory is then not the lock that was measured as stale.
	local dir="$1" real
	real="$(command -v mv)" || return 1
	mkdir -p "$dir"
	{
		printf '#!/bin/sh\n'
		printf 'real=%q\n' "$real"
		printf 'lock=%q\n' "$2"
		printf 'new_owner=%q\n' "$3"
		cat <<'EOSH'
src=''; last=''
for arg in "$@"; do
	src="$last"
	last="$arg"
done
case "$src" in
*.lock.d)
	case "$last" in
	*.stale-*)
		rm -rf "$lock"
		mkdir "$lock"
		printf '%s\n' "$new_owner" > "$lock/owner"
		;;
	esac
	;;
esac
exec "$real" "$@"
EOSH
	} > "$dir/mv"
	chmod +x "$dir/mv"
}

wait_for_file() { # <path> — bounded wait for a file a background process writes
	local i=0
	while [ ! -e "$1" ]; do
		i=$((i + 1))
		if [ "$i" -ge 200 ]; then
			return 1
		fi
		sleep 0.05 2>/dev/null || sleep 1
	done
	return 0
}

nested_entry() { # <dir> — a leftover .tmp-* entry inside a snapshot directory
	local p
	for p in "$1"/.tmp-*; do
		if [ -e "$p" ] || [ -L "$p" ]; then
			printf '%s' "$p"
			return 0
		fi
	done
	return 0
}

entry_count() { # <dir> — top-level entries, dot files included
	local p n=0
	for p in "$1"/* "$1"/.[!.]*; do
		if [ -e "$p" ] || [ -L "$p" ]; then
			n=$((n + 1))
		fi
	done
	printf '%s' "$n"
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
EXT_INODE="$(file_inode "$RELEASES/$SHA/extensions/alpha/index.ts")"
MANIFEST_INODE="$(file_inode "$RELEASES/$SHA/manifest.json")"
DIR_MTIME="$(file_mtime "$RELEASES/$SHA")"
# Point current away from the existing snapshot: the fast path must flip it
# back instead of copying again.
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
INODE1="$(file_inode "$RELEASES/$SHA1/$PKG_REL")"
	assert_eq "$(file_inode "$KIT/$PKG_REL")" "$INODE1" "first snapshot hardlinks from the checkout"
printf 'export const pkg = "pi-coding-agent-v2"\n' > "$KIT/$PKG_REL.new"
mv -f "$KIT/$PKG_REL.new" "$KIT/$PKG_REL"
	if [ "$(file_inode "$KIT/$PKG_REL")" = "$INODE1" ]; then
		fail "test setup: the checkout file must have a new inode"
	fi
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "second snapshot"
	assert_eq "$(file_inode "$RELEASES/$SHA2/$PKG_REL")" "$INODE1" "node_modules hardlinked from previous current, not from the checkout"
	assert_grep "$RELEASES/$SHA2/$PKG_REL" 'pi-coding-agent"' "previous current content, not the checkout's new content"
	assert_eq "$(file_nlink "$RELEASES/$SHA2/$PKG_REL")" 2 "previous snapshot and the new one share the inode"
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
sed_inplace "s/$SHA1/$SHA2/" "$RELEASES/$SHA2/manifest.json"
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
printf 'export const subagents = 1\n' > "$RELEASES/$SHA4/$EXT_MARKER"
insert_line_before "$RELEASES/$SHA4/manifest.json" 4 '  "extra": 1,'
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
	fake_snapshot "$i" "2020010${i}0000.00"
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
#
# Which lock the CLI takes is feature-detected: flock(1) where it exists
# (GNU/Linux), an atomic mkdir of <releases>/.lock.d elsewhere (macOS). This
# test exercises the flock path; T22 covers the mkdir path on every host.

wait_for_flock_taken() { # <lockfile> — true once another process holds it
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
if have_flock; then
	# A held lock makes the otherwise instant fast path wait for it.
	flock -x "$RELEASES/.lock" -c 'sleep 3' &
	HOLDER=$!
	if ! wait_for_flock_taken "$RELEASES/.lock"; then
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
	if ! wait_for_flock_taken "$RELEASES/.lock"; then
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
else
	printf 'SKIP %s: flock(1) is absent on this host; the mkdir lock is covered by T22\n' "$CURRENT"
fi
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
printf '\n// second checkout\n' >> "$SANDBOX/kit2/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit2" "second"
SHA2="$(git -C "$SANDBOX/kit2" rev-parse HEAD)"
i=1
while [ "$i" -le 6 ]; do
	fake_snapshot "$i" "2020010${i}0000.00"
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

# ==============================================================================
# T18: the script must stay parseable by bash 3.2 (macOS system shell). Bash
# 3.2 cannot parse a `case` statement nested inside a process substitution or
# command substitution, and it parses the whole script before running anything,
# so a single such construct breaks every agent-kit command on macOS.

new_test "T18 bash 3.2 parse compatibility and no inline case in snapshot_prune"
PRUNE_BODY="$(extract_function "$INSTALLER" snapshot_prune)"
HELPER_BODY="$(extract_function "$INSTALLER" snapshot_is_sha_name)"
	[ -n "$PRUNE_BODY" ] || fail "could not extract snapshot_prune from $INSTALLER"
	[ -n "$HELPER_BODY" ] || fail "missing top-level helper snapshot_is_sha_name"
assert_contains "$HELPER_BODY" 'case "$1" in *[!0-9a-f]*) return 1 ;; esac' \
	"sha-name pattern match lives in the helper"
assert_contains "$PRUNE_BODY" 'snapshot_is_sha_name "$base" || continue' \
	"prune loop calls the helper"
PRUNE_CODE="$(printf '%s\n' "$PRUNE_BODY" | grep -v '^[[:space:]]*#' || true)"
case "$PRUNE_CODE" in
*case*) fail "snapshot_prune must not contain a case statement: bash 3.2 cannot parse one inside process substitution" ;;
esac
# The same rule applies to every helper the prune substitution calls: a
# top-level function is parsed on its own, an inline compound command is not.
for helper in snapshot_is_sha_name snapshot_mtime snapshot_stat_style snapshot_bounded; do
	BODY="$(extract_function "$INSTALLER" "$helper")"
	[ -n "$BODY" ] || fail "missing top-level helper $helper"
	case "$BODY" in
	*"<<<"*) fail "$helper must not use a bash 3.2-incompatible here-string" ;;
	esac
done
for inline in '$(case' '<(case' '`case'; do
	if printf '%s\n' "$PRUNE_BODY" | grep -Fq "$inline"; then
		fail "snapshot_prune must not inline a case inside $inline"
	fi
done
BASH32=""
if [ -n "${AGENT_KIT_BASH32:-}" ]; then
	BASH32="$(command -v "$AGENT_KIT_BASH32" 2>/dev/null || true)"
	[ -n "$BASH32" ] || fail "AGENT_KIT_BASH32=$AGENT_KIT_BASH32 is not an executable"
else
	BASH32="$(command -v /tmp/bash-3.2/bash 2>/dev/null || true)"
fi
if [ -n "$BASH32" ]; then
	assert_contains "$("$BASH32" -c 'printf %s "$BASH_VERSION"' 2>/dev/null || true)" 3.2 \
		"$BASH32 reports a bash 3.2 version"
	if OUT="$("$BASH32" -n "$INSTALLER" 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "bash 3.2 parses $INSTALLER"
	[ "$RC" -eq 0 ] || printf '%s\n' "$OUT" >&2
else
	[ -n "${AGENT_KIT_BASH32:-}" ] || printf 'SKIP %s: no bash 3.2 binary found (set AGENT_KIT_BASH32 to one)\n' "$CURRENT"
fi
pass

# ==============================================================================
# T19: the current flip and the chmod calls stay userland-portable. The flip
# must replace the link with a single rename — GNU mv -T where it exists, a
# perl rename(2) otherwise — and never nest the new link into the snapshot
# directory. BSD chmod reads `--` as a file name, so it must not be passed.
#
# The last-resort tier is forced with the exact BSD mv behaviour (any -T flag
# cluster is an illegal option) plus a failing perl, and the log has to show
# that `mv -fh` really ran: otherwise the assertion would pass on a host whose
# mv still has -T without ever reaching the fallback.

new_test "T19 the current flip and the chmod calls stay userland-portable"
make_kit "$KIT"
chmod 0555 "$KIT/extensions/alpha"
SHA1="$(head_sha)"
# The mv shim reproduces BSD mv (no -T, -h emulated, every call logged) and the
# chmod shim refuses `--`, so both the selected rename tier and the chmod form
# are visible in the logs.
make_bsd_mv_shim "$SANDBOX/shim-bsd-flags" "$SANDBOX/mv.log"
make_flag_shim "$SANDBOX/shim-bsd-flags" chmod -- "$SANDBOX/chmod.log"
RUN_PATH="$SANDBOX/shim-bsd-flags"
run_snapshot
	assert_eq "$RC" 0 "first snapshot under the shims"
	assert_link "$RELEASES/current" "$SHA1" "current flipped"
	if mv_has_T; then
		assert_grep "$SANDBOX/mv.log" "-Tf -- " "GNU mv replaced the link with -T"
	elif have_perl; then
		if grep -q -- '-fh ' "$SANDBOX/mv.log"; then
			fail "the atomic rename tier must run before the mv -h fallback"
		fi
		assert_eq "$(nested_temp_link "$RELEASES/$SHA1")" "" "no link was nested into the snapshot"
	else
		assert_grep "$SANDBOX/mv.log" "-fh " "BSD mv replaced the link with -h, not -f"
	fi
	assert_eq "$(file_nlink "$RELEASES/$SHA1/extensions/alpha/index.ts")" 1 "0555 extensions copied"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# A dangling symlink fails the hardlink copy and its real-copy fallback, so the
# 0555 temp tree has to be made removable before the cleanup can delete it.
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 2 "materialization failure under the shims"
	assert_eq "$(tmp_dirs)" 0 "0555 temp tree removed"
	assert_grep "$SANDBOX/chmod.log" "u+rwX" "temp cleanup chmods the copied 0555 tree"
	if grep -q -- '^--' "$SANDBOX/chmod.log"; then
		fail "chmod must not be called with -- on a BSD userland"
	fi
RUN_PATH=""
rm -f "$RELEASES/$SHA1/node_modules/typebox/broken"
run_snapshot
	assert_eq "$RC" 0 "retry succeeds under the shims"
	assert_link "$RELEASES/current" "$SHA2" "current advanced"
# Last resort: with no -T and no perl rename tier the flip still has to work,
# and the new link must still replace current instead of being moved into the
# snapshot.
printf '\n// third\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "third"
SHA3="$(head_sha)"
make_bsd_mv_shim "$SANDBOX/shim-last-resort" "$SANDBOX/mv-last.log"
make_fail_shim "$SANDBOX/shim-last-resort" perl
RUN_PATH="$SANDBOX/shim-last-resort"
run_snapshot
	assert_eq "$RC" 0 "snapshot without a perl rename tier"
	assert_link "$RELEASES/current" "$SHA3" "current flipped by the mv fallback"
	assert_eq "$(nested_temp_link "$RELEASES/$SHA3")" "" "the new link was not nested into the snapshot"
	assert_dir "$RELEASES/$SHA3/extensions" "the snapshot directory is still a snapshot"
	assert_grep "$SANDBOX/mv-last.log" "-Tf -- " "the GNU rename tier was tried first"
	assert_grep "$SANDBOX/mv-last.log" "-fh " "the mv -h last resort really ran"
RUN_PATH=""
# (d) the shim itself has to be correct on a GNU host too, where mv has no -h.
# BSD mv semantics are emulated for the flags the CLI uses instead of being
# forwarded, so a host mv that rejects -h still replaces the destination link
# instead of moving the new link into the snapshot directory.
REAL_MV="$(command -v mv)"
mkdir -p "$SANDBOX/gnu-like"
{
	printf '#!/bin/sh\n'
	printf 'real=%q\n' "$REAL_MV"
	cat <<'EOSH'
for arg in "$@"; do
	case "$arg" in
	-?*) case "$arg" in *h*) printf '%s: invalid option -- h\n' "$0" >&2; exit 64 ;; esac ;;
	esac
done
exec "$real" "$@"
EOSH
} > "$SANDBOX/gnu-like/mv"
chmod +x "$SANDBOX/gnu-like/mv"
PATH="$SANDBOX/gnu-like:$PATH" make_bsd_mv_shim "$SANDBOX/shim-gnu" "$SANDBOX/gnu.log"
mkdir -p "$SANDBOX/gnu-target"
ln -s "$SANDBOX/gnu-target" "$SANDBOX/gnu-current"
ln -s 0123456789abcdef "$SANDBOX/gnu-new"
PATH="$SANDBOX/shim-gnu:$PATH" mv -fh "$SANDBOX/gnu-new" "$SANDBOX/gnu-current"
RC=$?
	assert_eq "$RC" 0 "the mv shim emulates BSD -h instead of forwarding it"
	assert_eq "$(readlink "$SANDBOX/gnu-current")" "0123456789abcdef" \
		"the destination link was replaced, not followed"
	assert_no_file "$SANDBOX/gnu-target/gnu-new" "nothing was moved into the link target"
	assert_grep "$SANDBOX/gnu.log" "-fh " "the shim recorded the -h last resort"
pass

# ==============================================================================
# T20: retention order comes from mtimes. GNU stat -c %Y is the reference; the
# BSD fallback stat -f %m is forced by refusing -c, and the wrong order would
# prune the newest snapshot instead of the oldest.

new_test "T20 retention sorts by mtime with BSD stat"
if ! stat -f %m / >/dev/null 2>&1; then
	printf 'SKIP %s: this host has GNU stat; T5 covers the stat -c %%Y path\n' "$CURRENT"
else
	make_kit "$KIT"
	SHA="$(head_sha)"
	run_snapshot
	assert_eq "$RC" 0 "first snapshot"
	i=1
	while [ "$i" -le 6 ]; do
		fake_snapshot "$i" "2020010${i}0000.00"
		i=$((i + 1))
	done
	make_flag_shim "$SANDBOX/shim-bsd-stat" stat -c "$SANDBOX/stat.log"
	RUN_PATH="$SANDBOX/shim-bsd-stat"
	run_snapshot
	assert_eq "$RC" 0 "fast path with BSD stat"
	RUN_PATH=""
	assert_link "$RELEASES/current" "$SHA" "current kept"
	assert_no_file "$RELEASES/$(printf '%040d' 1)" "oldest candidate pruned"
	assert_dir "$RELEASES/$(printf '%040d' 2)" "newest candidates kept"
	assert_eq "$(snapshot_dirs)" 6 "current plus five newest kept"
	BSD_STAT_CALLS="$(grep -c -- '-f %m' "$SANDBOX/stat.log" || true)"
	if [ "${BSD_STAT_CALLS:-0}" -lt 6 ]; then
		fail "expected the BSD stat fallback for every candidate, saw ${BSD_STAT_CALLS:-0} calls"
	fi
	PROBE_CALLS="$(grep -c -- '-c %Y' "$SANDBOX/stat.log" || true)"
	assert_eq "${PROBE_CALLS:-0}" 1 "GNU stat was probed once and then abandoned"
	pass
fi

# ==============================================================================
# T21: the node_modules hardlink copy. GNU cp -aL --link is the reference; on
# BSD the tree is hardlinked with pax -rwLl, and a real copy remains the last
# resort so immutability never depends on the space saving.

new_test "T21 hardlink copy: cp --link, then pax, then a real copy"
make_kit "$KIT"
SHA="$(head_sha)"
make_flag_shim "$SANDBOX/shim-nolink" cp --link "$SANDBOX/cp.log"
if command -v pax >/dev/null 2>&1; then
	make_flag_shim "$SANDBOX/shim-nolink" pax -ZZZ "$SANDBOX/pax.log"
	RUN_PATH="$SANDBOX/shim-nolink"
	run_snapshot
	assert_eq "$RC" 0 "first snapshot without cp --link"
	RUN_PATH=""
	assert_grep "$SANDBOX/pax.log" "-rwLl . " "pax materialized the hardlink tree"
	assert_eq "$(file_inode "$RELEASES/$SHA/$PKG_REL")" "$(file_inode "$KIT/$PKG_REL")" \
		"pax hardlinked the runtime package to the checkout"
	assert_eq "$(file_nlink "$RELEASES/$SHA/$PKG_REL")" 2 "the pax copy shares the inode"
else
	printf 'SKIP %s: pax(1) is absent, cp --link is the only hardlink path here\n' "$CURRENT"
fi
# With pax failing too, the snapshot must still be built from a real copy.
make_flag_shim "$SANDBOX/shim-nopax" cp --link "$SANDBOX/cp2.log"
make_fail_shim "$SANDBOX/shim-nopax" pax
RUN_PATH="$SANDBOX/shim-nopax"
run_snapshot_at "$KIT" "$SANDBOX/releases-copy"
RUN_PATH=""
	assert_eq "$RC" 0 "first snapshot with a failing pax"
	assert_file "$SANDBOX/releases-copy/$SHA/$PKG_REL" "node_modules copied by the real-copy fallback"
	assert_eq "$(file_nlink "$SANDBOX/releases-copy/$SHA/$PKG_REL")" 1 "the fallback is a real copy"
	if [ "$(file_inode "$SANDBOX/releases-copy/$SHA/$PKG_REL")" = "$(file_inode "$KIT/$PKG_REL")" ]; then
		fail "the real-copy fallback must not share the checkout inode"
	fi
	assert_link "$SANDBOX/releases-copy/current" "$SHA" "current flipped for the copied snapshot"
pass

# ==============================================================================
# T22: the mkdir lock used where flock(1) is absent (macOS): bounded wait, a
# bounded error, takeover of a lock left by a SIGKILLed holder, and release on
# exit (both after a successful and after a failed run).
#
# AGENT_KIT_SNAPSHOT_LOCK=mkdir forces the mechanism, so this test covers the
# BSD lock path on every host instead of depending on a PATH where flock(1) is
# unrunnable — a non-executable `flock` earlier in PATH does not hide an
# executable one further down, so a PATH shim cannot force this branch. T15 and
# T23 cover the flock path.

new_test "T22 mkdir lock: bounded wait, stale takeover, release on exit"
make_kit "$KIT"
SHA="$(head_sha)"
LOCKDIR="$RELEASES/.lock.d"
run_mkdir_snapshot
	assert_eq "$RC" 0 "first snapshot with the mkdir lock"
	assert_no_file "$LOCKDIR" "lock directory removed on exit"
	assert_no_file "$RELEASES/.lock" "the flock lock file is not created"
# A fresh lock makes the otherwise instant fast path wait for it.
mkdir_lock_write "$LOCKDIR" 0 || fail "test setup: could not take the mkdir lock"
( sleep 3; release_lock_dir "$LOCKDIR" ) &
HOLDER=$!
( AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=30 run_mkdir_snapshot
  printf '%s' "$RC" > "$SANDBOX/rc"; printf '%s\n' "$OUT" > "$SANDBOX/out" ) &
WAITER=$!
sleep 1
	if ! kill -0 "$WAITER" 2>/dev/null; then
		fail "the fast path did not wait for the mkdir lock"
	fi
wait "$HOLDER" || true
wait "$WAITER" || true
	assert_eq "$(cat "$SANDBOX/rc")" 0 "waiter exit code"
	assert_contains "$(cat "$SANDBOX/out")" "already present" "waiter completed the fast path"
	assert_link "$RELEASES/current" "$SHA" "current intact after the wait"
# A lock that cannot be taken in the bounded wait is a clear, bounded error.
BEFORE="$(readlink "$RELEASES/current")"
mkdir_lock_write "$LOCKDIR" 0 || fail "test setup: could not take the mkdir lock"
( sleep 4; release_lock_dir "$LOCKDIR" ) &
HOLDER=$!
AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=1 run_mkdir_snapshot
wait "$HOLDER" || true
	if [ "$RC" -eq 0 ]; then
		fail "a timed-out mkdir lock must not exit 0"
	fi
	assert_contains "$OUT" "another snapshot is running" "mkdir lock timeout message"
	if [ "$(count_lines "$OUT")" -gt 2 ]; then
		fail "lock timeout output must stay bounded, got $(count_lines "$OUT") lines"
	fi
	assert_eq "$(readlink "$RELEASES/current")" "$BEFORE" "current untouched on lock timeout"
	assert_no_file "$LOCKDIR" "the failing run left no lock directory"
# A holder killed with SIGKILL leaves the directory behind: age-based takeover.
mkdir_lock_write "$LOCKDIR" 3600 || fail "test setup: could not write a stale mkdir lock"
run_mkdir_snapshot
	assert_eq "$RC" 0 "stale lock taken over"
	assert_contains "$OUT" "already present" "the fast path ran after the takeover"
	assert_no_file "$LOCKDIR" "the taken-over lock was released"
# A failed run releases the lock too.
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
ln -s "$SANDBOX/nowhere" "$RELEASES/$SHA/node_modules/typebox/broken"
run_mkdir_snapshot
	assert_eq "$RC" 2 "materialization failure with the mkdir lock"
	assert_no_file "$LOCKDIR" "lock released after a failed run"
rm -f "$RELEASES/$SHA/node_modules/typebox/broken"
run_mkdir_snapshot
	assert_eq "$RC" 0 "retry succeeds"
	assert_link "$RELEASES/current" "$SHA2" "current advanced"
pass

# ==============================================================================
# T23: the flock path — the GNU/Linux reference branch — must stay taken where a
# runnable flock(1) exists and must still be the mechanism the CLI reaches for
# when it is forced. A stub flock records the call, so the branch is covered on
# every host; the kernel semantics of the real tool are covered by T15 where the
# host ships flock(1).

new_test "T23 the flock path is taken when flock(1) exists"
make_kit "$KIT"
SHA="$(head_sha)"
make_stub_tool "$SANDBOX/shim-flock" flock "$SANDBOX/flock.log"
RUN_PATH="$SANDBOX/shim-flock"
run_flock_snapshot
	assert_eq "$RC" 0 "first snapshot through the flock branch"
RUN_PATH=""
	assert_link "$RELEASES/current" "$SHA" "current flipped under the flock branch"
	assert_file "$RELEASES/.lock" "the flock lock file is kept"
	assert_no_file "$RELEASES/.lock.d" "no mkdir lock directory when flock is used"
	assert_grep "$SANDBOX/flock.log" "-w 60 9" "the bounded wait and the descriptor reach flock"
# An unknown forced mechanism is a bounded error, not a silent fallback.
AGENT_KIT_SNAPSHOT_LOCK=bogus run_snapshot
	assert_eq "$RC" 2 "an unknown lock mechanism is refused"
	assert_contains "$OUT" "AGENT_KIT_SNAPSHOT_LOCK" "the lock mechanism message names the variable"
pass

# ==============================================================================
# T24: the stale-takeover race. Two waiters must never both believe they hold
# the same mkdir lock; a takeover must never silently remove a lock it did not
# measure as stale; a holder that loses its lock must fail loudly instead of
# writing further; and unlock must remove only its own lock.
#
# The race window is one rename, so the lock primitives are driven directly
# through a harness that extracts them verbatim from the CLI (the same way the
# race was reproduced in review).

new_test "T24 stale takeover hands the mkdir lock to one holder at a time"
make_kit "$KIT"
SHA="$(head_sha)"
run_mkdir_snapshot
	assert_eq "$RC" 0 "first snapshot"
LOCKDIR="$RELEASES/.lock.d"
CLAIM="$LOCKDIR.taking"
HARNESS="$SANDBOX/lock-harness"
make_lock_harness "$HARNESS" || fail "test setup: could not extract the lock primitives"
assert_file "$HARNESS" "the lock harness was written"
make_slow_takeover_mv_shim "$SANDBOX/shim-slow-mv" || fail "test setup: could not install the slow mv shim"
ORACLE="$SANDBOX/hold-oracle"
RACE="$SANDBOX/race.log"
: > "$RACE"
# (a) both waiters measure the same stale lock; the first takeover creates a
# fresh lock, the second waiter's move (based on the same stale measurement)
# lands on it.
mkdir_lock_write "$LOCKDIR" 3600 || fail "test setup: could not write a stale lock"
( PATH="$SANDBOX/shim-slow-mv:$PATH" MV_DELAY_S=1 "$HARNESS" lock "$LOCKDIR" "$ORACLE" 4 "$RACE" >"$SANDBOX/a.out" 2>&1
  printf '%s' "$?" > "$SANDBOX/a.rc" ) &
A=$!
( PATH="$SANDBOX/shim-slow-mv:$PATH" MV_DELAY_S=3 "$HARNESS" lock "$LOCKDIR" "$ORACLE" 1 "$RACE" >"$SANDBOX/b.out" 2>&1
  printf '%s' "$?" > "$SANDBOX/b.rc" ) &
B=$!
wait "$A" || true
wait "$B" || true
	assert_eq "$(cat "$SANDBOX/a.rc" 2>/dev/null)" 0 "first waiter exit code ($(cat "$SANDBOX/a.out" 2>/dev/null))"
	assert_eq "$(cat "$SANDBOX/b.rc" 2>/dev/null)" 0 "second waiter exit code ($(cat "$SANDBOX/b.out" 2>/dev/null))"
	if grep -q '^overlap' "$RACE"; then
		fail "two processes held the mkdir lock at the same time: $(tr '\n' ' ' < "$RACE")"
	fi
	assert_eq "$(grep -c '^hold' "$RACE" 2>/dev/null || true)" 2 "both waiters acquired the lock, one after the other"
	assert_no_file "$LOCKDIR" "the lock directory is released"
	assert_no_file "$CLAIM" "no takeover claim left behind"
	assert_eq "$(ls -d "$RELEASES"/.lock.d.stale-* 2>/dev/null | wc -l | tr -d ' ')" 0 "no displaced lock left behind"
# (b) the second guard: a takeover that moves a lock it did not measure as stale
# must put it back instead of deleting it. The shim swaps the lock while the
# takeover move is in flight.
make_swap_lock_mv_shim "$SANDBOX/shim-swap-lock" "$LOCKDIR" "4242"$'\t'"$(date +%s)" || \
	fail "test setup: could not install the lock-swapping mv shim"
SWAP_LOG="$SANDBOX/swap.log"
: > "$SWAP_LOG"
mkdir_lock_write "$LOCKDIR" 3600 || fail "test setup: could not write a stale lock"
PATH="$SANDBOX/shim-swap-lock:$PATH" "$HARNESS" takeover "$LOCKDIR" "$SWAP_LOG" || true
	assert_grep "$SWAP_LOG" "takeover rc=1" "a takeover that displaced a fresh lock is refused"
	assert_dir "$LOCKDIR" "the displaced lock is restored under its name"
	assert_contains "$(cat "$LOCKDIR/owner" 2>/dev/null)" "4242" "the restored lock kept its owner line"
	assert_no_file "$CLAIM" "the refused takeover released its claim"
	assert_eq "$(ls -d "$RELEASES"/.lock.d.stale-* 2>/dev/null | wc -l | tr -d ' ')" 0 "the displaced lock was not left aside"
rm -rf "$LOCKDIR"
# (c) a holder whose lock is taken over fails loudly before its next critical
# section instead of writing into a releases dir it no longer locks.
VERIFY_LOG="$SANDBOX/verify.log"
: > "$VERIFY_LOG"
( "$HARNESS" verify "$LOCKDIR" "$VERIFY_LOG" >"$SANDBOX/v.out" 2>"$SANDBOX/v.err"
  printf '%s' "$?" > "$SANDBOX/v.rc" ) &
V=$!
wait_for_file "$VERIFY_LOG.ready" || fail "test setup: the verifying holder did not start"
mv "$LOCKDIR" "$SANDBOX/displaced-lock" || fail "test setup: could not displace the lock"
mkdir "$LOCKDIR" || fail "test setup: could not create the foreign lock"
printf '4242\t%s\n' "$(date +%s)" > "$LOCKDIR/owner"
: > "$VERIFY_LOG.go"
wait "$V" || true
	if [ "$(cat "$SANDBOX/v.rc" 2>/dev/null)" = 0 ]; then
		fail "a holder that lost its lock continued silently: $(cat "$SANDBOX/v.out" 2>/dev/null)"
	fi
	assert_contains "$(cat "$SANDBOX/v.err" 2>/dev/null)" "lost the lock" "the lost lock is reported"
	assert_eq "$(grep -c 'verify passed' "$VERIFY_LOG" 2>/dev/null || true)" 0 "the critical section did not run after the loss"
	assert_dir "$LOCKDIR" "the foreign lock is left in place"
	assert_contains "$(cat "$LOCKDIR/owner" 2>/dev/null)" "4242" "the foreign owner line is untouched"
# (d) unlock removes only the lock this process still owns.
rm -rf "$LOCKDIR" "$SANDBOX/displaced-lock"
UNLOCK_LOG="$SANDBOX/unlock.log"
( "$HARNESS" unlock "$LOCKDIR" "$UNLOCK_LOG" >"$SANDBOX/u.out" 2>"$SANDBOX/u.err"
  printf '%s' "$?" > "$SANDBOX/u.rc" ) &
U=$!
wait_for_file "$UNLOCK_LOG.ready" || fail "test setup: the unlocking holder did not start"
mv "$LOCKDIR" "$SANDBOX/own-lock" || fail "test setup: could not move the own lock"
mkdir "$LOCKDIR" || fail "test setup: could not create the foreign lock"
printf '4242\t%s\n' "$(date +%s)" > "$LOCKDIR/owner"
: > "$UNLOCK_LOG.go"
wait "$U" || true
	assert_eq "$(cat "$SANDBOX/u.rc" 2>/dev/null)" 0 "unlock without ownership is not a failure"
	assert_contains "$(cat "$SANDBOX/u.err" 2>/dev/null)" "leaving it in place" "unlock reports the foreign lock"
	assert_dir "$LOCKDIR" "a foreign lock survives unlock"
	assert_contains "$(cat "$LOCKDIR/owner" 2>/dev/null)" "4242" "the foreign owner line survives unlock"
rm -rf "$LOCKDIR" "$SANDBOX/own-lock"
# (e) end to end: a stale lock plus three real concurrent runs. Exactly one
# takeover may win; every run has to finish with current on a complete snapshot.
mkdir_lock_write "$LOCKDIR" 3600 || fail "test setup: could not write a stale lock"
i=0
while [ "$i" -le 2 ]; do
	( AGENT_KIT_SNAPSHOT_LOCK_TIMEOUT=60 run_mkdir_snapshot
	  printf '%s' "$RC" > "$SANDBOX/storm.$i.rc" ) &
	i=$((i + 1))
done
wait || true
i=0
while [ "$i" -le 2 ]; do
	assert_eq "$(cat "$SANDBOX/storm.$i.rc" 2>/dev/null)" 0 "storm run $i exit code"
	i=$((i + 1))
done
	assert_link "$RELEASES/current" "$SHA" "current still points at the snapshot of HEAD"
	assert_file "$RELEASES/current/manifest.json" "current resolves to a complete snapshot"
	assert_no_file "$LOCKDIR" "the storm left no lock directory"
	assert_no_file "$CLAIM" "the storm left no takeover claim"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T25: a snapshot directory that appears between the target-absence check and
# the publish rename is a conflict. Plain mv would nest the built temp tree
# inside the published snapshot, mutate it, and then validate the pre-existing
# content and exit 0 — which is exactly the reviewer's reproduction.

new_test "T25 a snapshot appearing before the publish rename is a conflict"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" "next"
SHA2="$(head_sha)"
# (a) a complete snapshot of the new sha is planted at the publish rename, so
# the rename target exists while the built tree is being moved.
make_publish_shim "$SANDBOX/shim-plant" "$RELEASES/$SHA1" "$RELEASES/$SHA2" \
	"$SHA1" "$SHA2" "$SANDBOX/plant.log" first 0 || fail "test setup: could not install the plant shim"
RUN_PATH="$SANDBOX/shim-plant"
run_snapshot
	assert_eq "$RC" 2 "publish conflict exits non-zero"
	assert_contains "$OUT" "appeared while building" "publish conflict message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the publish conflict"
	assert_grep "$SANDBOX/plant.log" ".tmp-" "the plant fired on the publish rename"
	assert_eq "$(nested_entry "$RELEASES/$SHA2")" "" "the temp tree was not nested into the published snapshot"
	assert_eq "$(entry_count "$RELEASES/$SHA2")" 3 "the published snapshot is unchanged"
	assert_eq "$(tmp_dirs)" 0 "the temp tree was cleaned up"
# (b) the last-resort tier: no -T, no perl. The plant lands right at the plain
# mv, which nests the tree, so the guard has to detect it, undo it and fail.
rm -rf "$RELEASES/$SHA2"
make_publish_shim "$SANDBOX/shim-nest" "$RELEASES/$SHA1" "$RELEASES/$SHA2" \
	"$SHA1" "$SHA2" "$SANDBOX/nest.log" plain 1 || fail "test setup: could not install the nesting shim"
make_fail_shim "$SANDBOX/shim-nest" perl
RUN_PATH="$SANDBOX/shim-nest"
run_snapshot
	assert_eq "$RC" 2 "a nested publish exits non-zero"
	assert_contains "$OUT" "appeared while building" "nested publish message"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the nested publish"
	assert_grep "$SANDBOX/nest.log" "-T -- " "the GNU rename tier was tried first"
	assert_grep "$SANDBOX/nest.log" "-- $RELEASES/.tmp-" "the guarded plain mv ran as the last resort"
	assert_eq "$(nested_entry "$RELEASES/$SHA2")" "" "the nested temp tree was undone"
	assert_eq "$(entry_count "$RELEASES/$SHA2")" 3 "the published snapshot is unchanged"
	assert_eq "$(tmp_dirs)" 0 "the temp tree was cleaned up after the undo"
RUN_PATH=""
rm -rf "$RELEASES/$SHA2"
run_snapshot
	assert_eq "$RC" 0 "the retry succeeds once the conflicting directory is gone"
	assert_link "$RELEASES/current" "$SHA2" "current advanced after the conflict"
pass

# ==============================================================================
# T26: a holder displaced in the middle of a prune must not keep deleting the
# list it selected. Ownership verified once for the whole loop is not enough: a
# holder that is paused after that check loses its lock to an age-based
# takeover, the new owner repoints current at one of the old candidates, and the
# resumed holder deletes the new current. Lock ownership and the current target
# are therefore re-checked per directory; the displaced holder dies loudly.

new_test "T26 a displaced prune holder never deletes the new current"
make_kit "$KIT"
SHA_OLD="$(head_sha)"
run_mkdir_snapshot
	assert_eq "$RC" 0 "seed snapshot"
# A second checkout with a newer HEAD: the snapshot whose prune gets paused.
cp -Rp "$KIT" "$SANDBOX/kit-a"
printf '\n// newer\n' >> "$SANDBOX/kit-a/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit-a" newer
SHA_NEW="$(git -C "$SANDBOX/kit-a" rev-parse HEAD)"
touch -t 200001010000 "$RELEASES/$SHA_OLD"
# Five keepers with 2020 mtimes and one extra candidate with a 2002 mtime: the
# seed snapshot is the oldest entry, so the pruner's deletion list is
# [fake1, extra, $SHA_OLD] and the pause lands on `extra`. $SHA_OLD is still
# ahead when the pruner resumes, and by then the second process has made it the
# current target: the resumed holder has to die on the ownership re-check
# instead of deleting it.
i=1
while [ "$i" -le 5 ]; do
	fake_snapshot "$i" "2020010${i}0000.00"
	i=$((i + 1))
done
fake_snapshot 9 "200201010000.00"
EXTRA="$RELEASES/$(printf '%040d' 9)"
make_pause_shim "$SANDBOX/shim-pause-rm" rm "$SANDBOX/gate" "$EXTRA" || \
	fail "test setup: could not install the pause shim"
( PATH="$SANDBOX/shim-pause-rm:$PATH" AGENT_KIT_SNAPSHOT_LOCK=mkdir \
	AGENT_KIT_SNAPSHOT_LOCK_STALE=2 AGENT_KIT_ROOT="$SANDBOX/kit-a" \
	"$INSTALLER" snapshot "$RELEASES" > "$SANDBOX/a.log" 2>&1
  printf '%s' "$?" > "$SANDBOX/a.rc" ) &
A=$!
wait_for_file "$SANDBOX/gate.ready" || fail "test setup: the pruner never reached its first deletion"
# Let the pruner's lock age past the takeover threshold, then hand the releases
# dir to the second checkout; it flips current onto the seed snapshot.
sleep 3
if OUT="$(AGENT_KIT_SNAPSHOT_LOCK=mkdir AGENT_KIT_SNAPSHOT_LOCK_STALE=2 \
	AGENT_KIT_ROOT="$KIT" "$INSTALLER" snapshot "$RELEASES" 2>&1)"; then RC=0; else RC=$?; fi
[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	assert_eq "$RC" 0 "the second snapshot ran under a takeover ($OUT)"
	assert_link "$RELEASES/current" "$SHA_OLD" "current moved to the second process's snapshot"
: > "$SANDBOX/gate.go"
wait "$A" || true
	if [ "$(cat "$SANDBOX/a.rc" 2>/dev/null)" = 0 ]; then
		fail "the displaced pruner exited 0: $(cat "$SANDBOX/a.log" 2>/dev/null)"
	fi
	assert_contains "$(cat "$SANDBOX/a.log" 2>/dev/null)" "lost the lock" \
		"the displaced pruner reports the lost lock"
	assert_dir "$RELEASES/$SHA_OLD" "the new current's target survived the displaced prune"
	assert_link "$RELEASES/current" "$SHA_OLD" "current was not repointed by the resumed pruner"
	assert_file "$RELEASES/current/manifest.json" "current still resolves to a complete snapshot"
	if [ "$(count_lines "$(cat "$SANDBOX/a.log" 2>/dev/null)")" -gt 3 ]; then
		fail "the displaced pruner output must stay bounded: $(cat "$SANDBOX/a.log" 2>/dev/null)"
	fi
	assert_no_file "$RELEASES/.lock.d" "no lock directory left behind"
	assert_eq "$(ls -d "$RELEASES"/.lock.d.stale-* "$RELEASES"/.lock.d.release-* \
		2>/dev/null | wc -l | tr -d ' ')" 0 "no displaced lock left aside"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
pass

# ==============================================================================
# T27: releasing the mkdir lock is a validated move, not a delete. Checking
# ownership and then removing the directory lets an age takeover slip in: the
# exiting process then removes the NEW holder's lock and that holder dies. The
# release moves the lock aside atomically, reads the owner line of what it
# moved, and puts a foreign lock back.

new_test "T27 unlock never removes a lock taken over by another process"
make_kit "$KIT"
run_mkdir_snapshot
	assert_eq "$RC" 0 "seed snapshot"
cp -Rp "$KIT" "$SANDBOX/kit-a"
printf '\n// a\n' >> "$SANDBOX/kit-a/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit-a" a
cp -Rp "$KIT" "$SANDBOX/kit-c"
printf '\n// c\n' >> "$SANDBOX/kit-c/extensions/alpha/index.ts"
git_commit_all "$SANDBOX/kit-c" c
SHA_C="$(git -C "$SANDBOX/kit-c" rev-parse HEAD)"
LOCKDIR="$RELEASES/.lock.d"
make_pause_mv_shim "$SANDBOX/shim-pause-mv" "$SANDBOX/unlock" "$LOCKDIR" || \
	fail "test setup: could not install the release pause shim"
make_pause_shim "$SANDBOX/shim-pause-cp" cp "$SANDBOX/copy" "$SANDBOX/kit-c/extensions/." || \
	fail "test setup: could not install the copy pause shim"
# A finishes its snapshot and pauses right before releasing its lock.
( PATH="$SANDBOX/shim-pause-mv:$PATH" AGENT_KIT_SNAPSHOT_LOCK=mkdir \
	AGENT_KIT_SNAPSHOT_LOCK_STALE=2 AGENT_KIT_ROOT="$SANDBOX/kit-a" \
	"$INSTALLER" snapshot "$RELEASES" > "$SANDBOX/a.log" 2>&1
  printf '%s' "$?" > "$SANDBOX/a.rc" ) &
A=$!
wait_for_file "$SANDBOX/unlock.ready" || fail "test setup: the first process never reached its release"
A_OWNER="$(head -1 "$LOCKDIR/owner" 2>/dev/null || true)"
	if [ -z "$A_OWNER" ]; then
		fail "test setup: the paused holder has no owner line"
	fi
sleep 3
# B takes the stale lock over and starts materializing, so its lock is live when
# the paused process resumes and releases.
( PATH="$SANDBOX/shim-pause-cp:$PATH" AGENT_KIT_SNAPSHOT_LOCK=mkdir \
	AGENT_KIT_SNAPSHOT_LOCK_STALE=2 AGENT_KIT_ROOT="$SANDBOX/kit-c" \
	"$INSTALLER" snapshot "$RELEASES" > "$SANDBOX/c.log" 2>&1
  printf '%s' "$?" > "$SANDBOX/c.rc" ) &
C=$!
wait_for_file "$SANDBOX/copy.ready" || fail "test setup: the new holder never started materializing"
C_OWNER="$(head -1 "$LOCKDIR/owner" 2>/dev/null || true)"
	if [ -z "$C_OWNER" ] || [ "$C_OWNER" = "$A_OWNER" ]; then
		fail "test setup: the lock was not taken over (owner line '$C_OWNER')"
	fi
: > "$SANDBOX/unlock.go"
wait "$A" || true
	assert_eq "$(cat "$SANDBOX/a.rc" 2>/dev/null)" 0 "the releasing process is not a failure"
	assert_contains "$(cat "$SANDBOX/a.log" 2>/dev/null)" "leaving it in place" \
		"the release reports the foreign lock"
	assert_dir "$LOCKDIR" "the new holder's lock survived the foreign release"
	assert_eq "$(head -1 "$LOCKDIR/owner" 2>/dev/null)" "$C_OWNER" "the new holder still owns the lock"
: > "$SANDBOX/copy.go"
wait "$C" || true
	assert_eq "$(cat "$SANDBOX/c.rc" 2>/dev/null)" 0 "the new holder completed ($(cat "$SANDBOX/c.log" 2>/dev/null))"
	assert_link "$RELEASES/current" "$SHA_C" "current points at the new holder's snapshot"
	assert_file "$RELEASES/current/manifest.json" "current resolves to a complete snapshot"
	assert_no_file "$LOCKDIR" "the new holder released its own lock"
	assert_eq "$(ls -d "$RELEASES"/.lock.d.release-* 2>/dev/null | wc -l | tr -d ' ')" 0 \
		"no release aside left behind"
pass

# ==============================================================================
# T28: the last-resort publish rename can nested the built tree inside a
# published snapshot. When the undo move fails, that nested tree is our own
# build and must be destroyed in place: dying while leaving a .tmp-* inside an
# immutable snapshot is exactly the mutation the contract forbids. When even the
# removal fails, the diagnostic names the path that really exists and the EXIT
# cleanup still reaches it.

new_test "T28 a failed publish undo destroys the nested build in place"
make_kit "$KIT"
SHA1="$(head_sha)"
run_snapshot
	assert_eq "$RC" 0 "first snapshot"
printf '\n// next\n' >> "$KIT/extensions/alpha/index.ts"
git_commit_all "$KIT" next
SHA2="$(head_sha)"
make_publish_shim "$SANDBOX/shim-undo" "$RELEASES/$SHA1" "$RELEASES/$SHA2" \
	"$SHA1" "$SHA2" "$SANDBOX/undo.log" plain 1 1 || \
	fail "test setup: could not install the undo shim"
make_fail_shim "$SANDBOX/shim-undo" perl
RUN_PATH="$SANDBOX/shim-undo"
run_snapshot
	assert_eq "$RC" 2 "a publish whose undo fails exits non-zero"
	assert_contains "$OUT" "appeared while building" "the publish conflict is reported"
	assert_contains "$OUT" "destroyed in place" "the failure names what happened to the nested build"
	assert_eq "$(nested_entry "$RELEASES/$SHA2")" "" "no nested temp tree left in the published snapshot"
	assert_eq "$(entry_count "$RELEASES/$SHA2")" 3 "the published snapshot is unchanged"
	assert_eq "$(tmp_dirs)" 0 "no temp dir left behind"
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the failed publish"
# (b) the removal of the nested build fails too: the message must name the tree
# that really exists, and the EXIT cleanup must reach a .tmp-* one level deep.
rm -rf "$RELEASES/$SHA2"
make_publish_shim "$SANDBOX/shim-stuck" "$RELEASES/$SHA1" "$RELEASES/$SHA2" \
	"$SHA1" "$SHA2" "$SANDBOX/stuck.log" plain 1 1 || \
	fail "test setup: could not install the stuck shim"
make_fail_shim "$SANDBOX/shim-stuck" perl
make_fail_prefix_rm_shim "$SANDBOX/shim-stuck" "$RELEASES/$SHA2/.tmp-" || \
	fail "test setup: could not install the removal shim"
RUN_PATH="$SANDBOX/shim-stuck"
run_snapshot
	assert_eq "$RC" 2 "a publish whose cleanup also fails exits non-zero"
	assert_contains "$OUT" "must be removed manually" "the diagnostic says what is left"
	assert_contains "$OUT" "could not remove the temporary directory" "cleanup reports the tree it could not remove"
	STUCK="$(nested_entry "$RELEASES/$SHA2")"
	if [ -z "$STUCK" ]; then
		fail "the stuck build is gone, the diagnostic cannot be checked against reality"
	else
		assert_contains "$OUT" "$STUCK" "the diagnostic names the path that really exists"
	fi
	assert_link "$RELEASES/current" "$SHA1" "current untouched by the stuck publish"
RUN_PATH=""
rm -rf "$RELEASES/$SHA2" 2>/dev/null || {
	chmod -R u+w "$RELEASES/$SHA2" 2>/dev/null || true
	rm -rf "$RELEASES/$SHA2" 2>/dev/null || true
}
pass

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
