#!/usr/bin/env bash
#
# Ownership-semantics tests for bin/agent-kit.
#
# Every test runs in a fresh sandbox: fake $HOME, fake PATH with only the
# runtime stubs the test provides, and a minimal synthetic agent-kit tree.
# Nothing outside the sandbox is read or written (the real repository is
# only copied from, never modified).
#
# Usage: tests/installer/run.sh [-v]
#   -v  print installer output for each test
#
# Exit code: 0 when all tests pass, 1 otherwise.
set -euo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_REPO="$(cd "$SELF_DIR/../.." && pwd -P)"
INSTALLER="$REAL_REPO/bin/agent-kit"

SANDBOX=""
PASS=0
FAIL=0
CURRENT=""

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

assert_link() { # <path> <expected-target> <what>
	if [ ! -L "$1" ]; then
		fail "$3: not a symlink: $1"
		return
	fi
	assert_eq "$(readlink "$1")" "$2" "$3"
}

assert_file() { # <path> <what>
	[ -f "$1" ] || fail "$2: missing file $1"
}

assert_no_file() { # <path> <what> — dangling symlinks count as existing
	if [ -e "$1" ] || [ -L "$1" ]; then
		fail "$2: path should not exist: $1"
	fi
}

run_install() { # <args...> — sets OUT and RC
	if OUT="$("$SANDBOX/kit/bin/agent-kit" install "$@" 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

run_uninstall() { # <args...>
	if OUT="$("$SANDBOX/kit/bin/agent-kit" uninstall "$@" 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

# --- sandbox -----------------------------------------------------------------

new_test() { # <name>
	CURRENT="$1"
	FAIL_AT_START=$FAIL
	SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-kit-test.XXXXXX")"
	SANDBOX="$(cd "$SANDBOX" && pwd -P)"   # canonical: macOS /tmp is /private/tmp
	export HOME="$SANDBOX/home"
	mkdir -p "$HOME"
	unset XDG_STATE_HOME PI_AGENT_DIR OMP_AGENT_DIR OPENCODE_CONFIG_DIR 2>/dev/null || true
	STATE="$HOME/.local/state/agent-kit/links.tsv"
}

cleanup() {
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	rm -rf "$SANDBOX"
}
trap cleanup EXIT

make_stub_bin() { # <bin-dir> <runtime-names...>
	mkdir -p "$1"
	local r
	for r in "${@:2}"; do
		printf '#!/bin/sh\nexit 0\n' > "$1/$r"
		chmod +x "$1/$r"
	done
}

use_path() { # <bin-dir or "empty">
	if [ "$1" = "empty" ]; then
		PATH="/usr/bin:/bin"
	else
		PATH="$1:/usr/bin:/bin"
	fi
	export PATH
}

# Minimal synthetic checkout following the repository conventions.
# Roots the installer at $SANDBOX/kit via AGENT_KIT_ROOT.
make_kit() { # <checkout-dir>
	local d="$1"
	mkdir -p "$d/bin" \
		"$d/shared/skills/alpha" "$d/shared/skills/beta" "$d/shared/skills/marked" \
		"$d/runtimes/pi/skills/pi-only" "$d/runtimes/pi/extensions/todo" \
		"$d/runtimes/omp/extensions" "$d/runtimes/omp/managed-skills/verify" \
		"$d/runtimes/opencode/skills/oc-only" "$d/runtimes/opencode/skills/git-commit" \
		"$d/runtimes/opencode/agents/primary" \
		"$d/runtimes/opencode/plugins"
	cp "$INSTALLER" "$d/bin/agent-kit"
	echo "# alpha" > "$d/shared/skills/alpha/SKILL.md"
	echo "# marked" > "$d/shared/skills/marked/SKILL.md"
	printf 'pi omp\n' > "$d/shared/skills/marked/runtimes"
	echo "# beta" > "$d/shared/skills/beta/SKILL.md"
	echo "# pi-only" > "$d/runtimes/pi/skills/pi-only/SKILL.md"
	echo "export const x = 1" > "$d/runtimes/pi/extensions/todo/index.ts"
	echo "export const f = 1" > "$d/runtimes/pi/extensions/foot.ts"
	echo "rules" > "$d/runtimes/omp/RULES.md"
	echo "export const o = 1" > "$d/runtimes/omp/extensions/ompx.ts"
	echo "# managed" > "$d/runtimes/omp/managed-skills/verify/SKILL.md"
	echo "# oc-only" > "$d/runtimes/opencode/skills/oc-only/SKILL.md"
	echo "# opencode git-commit" > "$d/runtimes/opencode/skills/git-commit/SKILL.md"
	echo "general agent" > "$d/runtimes/opencode/agents/primary/general.md"
	echo "export const plugin = 1" > "$d/runtimes/opencode/plugins/rtk.ts"
}

fresh_install_env() { # <kit-dir> — installer invocation env
	AGENT_KIT_ROOT="$1"
	PI_AGENT_DIR="$HOME/.pi/agent"
	OMP_AGENT_DIR="$HOME/.omp/agent"
	OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
	export AGENT_KIT_ROOT PI_AGENT_DIR OMP_AGENT_DIR OPENCODE_CONFIG_DIR
}

state_lines() { # <runtime> — number of state entries for a runtime
	[ -f "$STATE" ] || { printf 0; return; }
	awk -F '\t' -v r="$1" '$1 == r' "$STATE" | wc -l | tr -d ' '
}

outside_skill() { # a real directory outside any checkout
	mkdir -p "$SANDBOX/outside/real-skill"
	echo external > "$SANDBOX/outside/real-skill/SKILL.md"
}

# ==============================================================================
# T1: install with no arguments detects only available runtimes

new_test "T1 autodetect"
make_stub_bin "$SANDBOX/bin" pi omp
use_path "$SANDBOX/bin"
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_file "$HOME/.pi/agent/skills/alpha/SKILL.md" "pi skill installed"
	assert_file "$HOME/.omp/agent/RULES.md" "omp root file installed"
	assert_no_file "$HOME/.config/opencode/AGENTS.md" "opencode untouched"
	assert_no_file "$HOME/.config/opencode/skills" "opencode untouched"
	case "$OUT" in
	*Skipped:*opencode*) : ;;
	*) fail "output should report skipped opencode" ;;
	esac
pass

# ==============================================================================
# T2: explicit `install pi` works without the binary in PATH

new_test "T2 explicit install without binary"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi
	assert_eq "$RC" 0 "exit code"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "link created despite missing binary"
	case "$OUT" in
	*warning:*"installing anyway"*) : ;;
	*) fail "output should warn about missing binary" ;;
	esac
	run_install bogus
	assert_eq "$RC" 2 "unknown runtime rejected"
pass

# ==============================================================================
# T3: first install creates links for every runtime and records ownership

new_test "T3 first install layout"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi omp opencode
	assert_eq "$RC" 0 "exit code"
	# pi: shared + runtime-specific skills, dirs and plain-file extensions
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "shared skill"
	assert_link "$HOME/.pi/agent/skills/pi-only" "$SANDBOX/kit/runtimes/pi/skills/pi-only" "runtime skill"
	assert_link "$HOME/.pi/agent/skills/marked" "$SANDBOX/kit/shared/skills/marked" "pi+omp-only shared skill"
	assert_link "$HOME/.pi/agent/extensions/todo" "$SANDBOX/kit/runtimes/pi/extensions/todo" "extension dir"
	assert_link "$HOME/.pi/agent/extensions/foot.ts" "$SANDBOX/kit/runtimes/pi/extensions/foot.ts" "extension file"
	# omp: root file, extension, managed skill
	assert_link "$HOME/.omp/agent/RULES.md" "$SANDBOX/kit/runtimes/omp/RULES.md" "omp root file"
	assert_link "$HOME/.omp/agent/extensions/ompx.ts" "$SANDBOX/kit/runtimes/omp/extensions/ompx.ts" "omp extension"
	assert_link "$HOME/.omp/agent/managed-skills/verify" "$SANDBOX/kit/runtimes/omp/managed-skills/verify" "omp managed skill"
	assert_link "$HOME/.omp/agent/skills/marked" "$SANDBOX/kit/shared/skills/marked" "marker admits omp"
	# opencode: skills, file-level agents, plugins
	assert_link "$HOME/.config/opencode/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "opencode shared skill"
	assert_link "$HOME/.config/opencode/skills/oc-only" "$SANDBOX/kit/runtimes/opencode/skills/oc-only" "opencode skill"
	assert_link "$HOME/.config/opencode/skills/git-commit" "$SANDBOX/kit/runtimes/opencode/skills/git-commit" "opencode colocated git-commit"
	assert_no_file "$HOME/.config/opencode/skills/marked" "marker excludes opencode"
	assert_link "$HOME/.config/opencode/agents/primary/general.md" "$SANDBOX/kit/runtimes/opencode/agents/primary/general.md" "opencode agent file"
	assert_link "$HOME/.config/opencode/plugins/rtk.ts" "$SANDBOX/kit/runtimes/opencode/plugins/rtk.ts" "opencode plugin"
	# ownership recorded for all three runtimes
	assert_eq "$(state_lines pi)" 6 "pi state entries"
	assert_eq "$(state_lines omp)" 6 "omp state entries"
	assert_eq "$(state_lines opencode)" 6 "opencode state entries"
pass

# ==============================================================================
# T4: reinstall from the same checkout is idempotent

new_test "T4 idempotent reinstall"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi omp opencode
	assert_eq "$RC" 0 "first install"
	STATE_BEFORE="$(cat "$STATE")"
	run_install pi omp opencode
	assert_eq "$RC" 0 "second install"
	assert_eq "$(cat "$STATE")" "$STATE_BEFORE" "state unchanged"
	case "$OUT" in
	*"0 created, 0 relinked"*) : ;;
	*) fail "second install should change nothing, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T5: install from another checkout switches managed links only

new_test "T5 checkout switch"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi omp
	assert_eq "$RC" 0 "base install"
	# second checkout: adds gamma, drops beta, edits alpha
	make_kit "$SANDBOX/kit2"
	mkdir -p "$SANDBOX/kit2/shared/skills/gamma"
	echo "# gamma" > "$SANDBOX/kit2/shared/skills/gamma/SKILL.md"
	rm -rf "$SANDBOX/kit2/shared/skills/beta"
	echo "# alpha v2" > "$SANDBOX/kit2/shared/skills/alpha/SKILL.md"
	AGENT_KIT_ROOT="$SANDBOX/kit2" run_install pi
	assert_eq "$RC" 0 "switch install"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit2/shared/skills/alpha" "alpha repointed"
	assert_link "$HOME/.pi/agent/skills/gamma" "$SANDBOX/kit2/shared/skills/gamma" "gamma created from kit2"
	assert_no_file "$HOME/.pi/agent/skills/beta" "beta pruned"
	assert_link "$HOME/.omp/agent/RULES.md" "$SANDBOX/kit/runtimes/omp/RULES.md" "omp still on kit1"
	assert_file "$SANDBOX/kit/shared/skills/beta/SKILL.md" "old checkout files untouched"
	assert_eq "$(state_lines pi)" 6 "pi state tracks kit2 set"
	assert_eq "$(state_lines omp)" 6 "omp state unchanged"
pass

# ==============================================================================
# T6: unrelated external symlink in the destination is never touched

new_test "T6 foreign symlink untouched"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
	mkdir -p "$HOME/.pi/agent/skills"
	ln -s "$SANDBOX/outside/real-skill" "$HOME/.pi/agent/skills/external"
run_install pi
	assert_eq "$RC" 0 "exit code"
	assert_link "$HOME/.pi/agent/skills/external" "$SANDBOX/outside/real-skill" "foreign link kept"
	grep -q "skills/external" "$STATE" && fail "foreign link must not be in state"
run_uninstall pi
	assert_link "$HOME/.pi/agent/skills/external" "$SANDBOX/outside/real-skill" "foreign link survives uninstall"
pass

# ==============================================================================
# T7: a real file/dir at a desired target is never overwritten

new_test "T7 real file conflict"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
	mkdir -p "$HOME/.pi/agent/skills/alpha"
	echo mine > "$HOME/.pi/agent/skills/alpha/SKILL.md"
run_install pi
	assert_eq "$RC" 1 "conflict fails the install"
	assert_file "$HOME/.pi/agent/skills/alpha/SKILL.md" "user file intact"
	assert_eq "$(cat "$HOME/.pi/agent/skills/alpha/SKILL.md")" "mine" "content intact"
	grep -q "skills/alpha" "$STATE" && fail "conflicted path must not be owned"
	case "$OUT" in
	*"not a symlink"*) : ;;
	*) fail "should explain the real-file conflict" ;;
	esac
run_uninstall pi
	assert_file "$HOME/.pi/agent/skills/alpha/SKILL.md" "user file survives uninstall"
pass

# ==============================================================================
# T8: a managed link redirected by the user is never deleted or replaced

new_test "T8 redirected managed link"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
	mkdir -p "$SANDBOX/outside/other"
	echo redirect > "$SANDBOX/outside/other/SKILL.md"
run_install pi
	assert_eq "$RC" 0 "base install"
	ln -sfn "$SANDBOX/outside/other" "$HOME/.pi/agent/skills/alpha"
run_install pi
	assert_eq "$RC" 1 "conflict reported"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/outside/other" "redirected link untouched"
	awk -F '\t' '$1 == "pi" && $2 == "skills/alpha"' "$STATE" | grep -q . && fail "ownership must be released"
run_uninstall pi
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/outside/other" "uninstall leaves redirected link"
pass

# ==============================================================================
# T9: an item removed from the repo is cleaned up on the next install

new_test "T9 removed item pruned"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi
	assert_eq "$RC" 0 "base install"
	rm -rf "$SANDBOX/kit/shared/skills/beta"
run_install pi
	assert_eq "$RC" 0 "reconcile install"
	assert_no_file "$HOME/.pi/agent/skills/beta" "removed item link deleted"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "other links intact"
	assert_eq "$(state_lines pi)" 5 "state entry cleaned"
pass

# ==============================================================================
# T10: same, but the user already replaced the link — it must survive

new_test "T10 removed item with redirected link"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
run_install pi
	assert_eq "$RC" 0 "base install"
	rm -rf "$SANDBOX/kit/shared/skills/beta"
	ln -sfn "$SANDBOX/outside/real-skill" "$HOME/.pi/agent/skills/beta"
run_install pi
	assert_eq "$RC" 0 "reconcile succeeds (only a forget note)"
	assert_link "$HOME/.pi/agent/skills/beta" "$SANDBOX/outside/real-skill" "user link untouched"
	awk -F '\t' '$1 == "pi" && $2 == "skills/beta"' "$STATE" | grep -q . && fail "ownership must be forgotten"
pass

# ==============================================================================
# T11: uninstall removes only provably owned links

new_test "T11 uninstall scope"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
	mkdir -p "$HOME/.pi/agent/skills"
	ln -s "$SANDBOX/outside/real-skill" "$HOME/.pi/agent/skills/external"
run_install pi omp
	assert_eq "$RC" 0 "base install"
run_uninstall pi
	assert_eq "$RC" 0 "uninstall"
	assert_no_file "$HOME/.pi/agent/skills/alpha" "owned shared link removed"
	assert_no_file "$HOME/.pi/agent/skills/pi-only" "owned runtime link removed"
	assert_no_file "$HOME/.pi/agent/extensions/todo" "owned extension removed"
	assert_link "$HOME/.pi/agent/skills/external" "$SANDBOX/outside/real-skill" "foreign link kept"
	assert_link "$HOME/.omp/agent/RULES.md" "$SANDBOX/kit/runtimes/omp/RULES.md" "omp untouched"
	assert_eq "$(state_lines pi)" 0 "pi state cleaned"
	assert_eq "$(state_lines omp)" 6 "omp state kept"
run_uninstall
	assert_eq "$(state_lines omp)" 0 "default uninstall covers all runtimes"
pass

# ==============================================================================
# T12: corrupt/stale state must not authorize deleting user paths

new_test "T12 corrupt state safety"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi
	assert_eq "$RC" 0 "base install"
	# poison the state: a real user file claimed as managed, plus garbage
	mkdir -p "$(dirname "$STATE")"
	{
		printf 'pi\tskills/alpha\t%s/important-user-file\n' "$HOME"
		printf 'garbage line without tabs\n'
		printf 'totally\t\n'
		printf '\n'
		printf 'pi\t../../etc/passwd\t/nowhere\n'
		printf 'foreign-runtime\tsomething\twhatever\n'
	} > "$STATE"
	echo precious > "$HOME/important-user-file"
run_uninstall pi
	assert_eq "$RC" 0 "uninstall survives corrupt state"
	assert_file "$HOME/important-user-file" "claimed-but-not-owned file must survive"
	case "$OUT" in
	*"released skills/alpha"*) : ;;
	*) fail "claimed file should be released, not deleted" ;;
	esac
run_install pi
	assert_eq "$RC" 0 "install survives corrupt state"
	assert_file "$HOME/important-user-file" "file still intact after install"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "install rebuilt the real link"
	grep -q "etc/passwd" "$STATE" && fail "path-traversal state entry must be dropped"
pass

# ==============================================================================
# T13: spaces in XDG state and runtime-root paths

new_test "T13 paths with spaces"
use_path empty
make_kit "$SANDBOX/kit"
	SANDBOX_SPACES="$SANDBOX/Some Folder (v2)"
	mkdir -p "$SANDBOX_SPACES/home"
	HOME="$SANDBOX_SPACES/home"
	XDG_STATE_HOME="$SANDBOX_SPACES/my state"
	PI_AGENT_DIR="$SANDBOX_SPACES/pi agent"
	export HOME XDG_STATE_HOME PI_AGENT_DIR
	STATE="$XDG_STATE_HOME/agent-kit/links.tsv"
	AGENT_KIT_ROOT="$SANDBOX/kit"
	export AGENT_KIT_ROOT
run_install pi
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_AGENT_DIR/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "link in spaced root"
	assert_file "$STATE" "state in spaced XDG path"
run_uninstall pi
	assert_no_file "$PI_AGENT_DIR/skills/alpha" "cleanup works with spaced paths"
pass

# ==============================================================================
# T14: duplicate desired destinations are a hard configuration error

new_test "T14 duplicate destinations rejected"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
	mkdir -p "$SANDBOX/kit/runtimes/pi/skills/alpha"
	echo dupe > "$SANDBOX/kit/runtimes/pi/skills/alpha/SKILL.md"
run_install pi
	assert_eq "$RC" 1 "duplicate destination fails"
	assert_no_file "$HOME/.pi/agent/skills/alpha" "nothing linked on config error"
	case "$OUT" in
	*"duplicate desired destinations"*) : ;;
	*) fail "should name the configuration error" ;;
	esac
pass

# ==============================================================================
# T15: poisoned traversal state must not authorize deleting a path outside
# the runtime root (state says ../../victim -> recorded source)

new_test "T15 poisoned traversal state"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
	mkdir -p "$SANDBOX/outside/target"
	echo victim-skill > "$SANDBOX/outside/target/SKILL.md"
run_install pi
	assert_eq "$RC" 0 "base install"
	ln -s "$SANDBOX/outside/target" "$HOME/victim"
	printf 'pi\t../../victim\t%s\n' "$SANDBOX/outside/target" > "$STATE"
run_uninstall pi
	assert_eq "$RC" 0 "uninstall survives poisoned state"
	assert_link "$HOME/victim" "$SANDBOX/outside/target" "symlink outside the runtime root survives"
	case "$OUT" in
	*"ignoring invalid state line"*) : ;;
	*) fail "traversal state line must be dropped with a warning" ;;
	esac
	awk -F '\t' '$2 == "../../victim"' "$STATE" 2>/dev/null | grep -q . && fail "traversal entry must not persist"
run_install pi
	assert_eq "$RC" 0 "install survives poisoned state"
	assert_link "$HOME/victim" "$SANDBOX/outside/target" "victim still intact after install"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "real links rebuilt normally"
pass

# ==============================================================================
# T16: install bootstraps ~/.local/bin/agent-kit and repoints it on
# checkout switch; a real file at the launcher path is left alone

new_test "T16 command bootstrap"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
run_install pi
	assert_eq "$RC" 0 "base install"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "launcher points at this checkout"
	OUT="$(env -u AGENT_KIT_ROOT -u PI_AGENT_DIR "$HOME/.local/bin/agent-kit" status 2>&1)"
	RC=$?
	assert_eq "$RC" 0 "bootstrapped launcher resolves its checkout without env overrides"
	case "$OUT" in
	*"wants 6 entity"*) : ;;
	*) fail "launcher status should see the checkout entities, got: $OUT" ;;
	esac
	make_kit "$SANDBOX/kit2"
	AGENT_KIT_ROOT="$SANDBOX/kit2" run_install pi
	assert_eq "$RC" 0 "install from kit2"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit2/bin/agent-kit" "launcher repointed to kit2"
	rm "$HOME/.local/bin/agent-kit"
	echo custom-script > "$HOME/.local/bin/agent-kit"
	AGENT_KIT_ROOT="$SANDBOX/kit" run_install pi
	assert_eq "$RC" 0 "real launcher file is a warning, not a failure"
	assert_eq "$(cat "$HOME/.local/bin/agent-kit")" "custom-script" "user launcher file untouched"
	case "$OUT" in
	*"command bootstrap skipped"*) : ;;
	*) fail "should warn about skipping the bootstrap" ;;
	esac
pass

# ==============================================================================
# T17: the launcher is owned via its own record; foreign symlinks at
# ~/.local/bin/agent-kit are never touched

new_test "T17 launcher ownership"
use_path empty
make_kit "$SANDBOX/kit"
fresh_install_env "$SANDBOX/kit"
outside_skill
	mkdir -p "$HOME/.local/bin" "$SANDBOX/outside"
	printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/outside/other-command"
	chmod +x "$SANDBOX/outside/other-command"
	# a) foreign symlink: untouched, not adopted
	ln -s "$SANDBOX/outside/other-command" "$HOME/.local/bin/agent-kit"
run_install pi
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/outside/other-command" "foreign launcher untouched"
	case "$OUT" in
	*"not managed by agent-kit; command bootstrap skipped"*) : ;;
	*) fail "foreign launcher should be reported" ;;
	esac
	[ -f "$HOME/.local/state/agent-kit/command.tsv" ] && \
		grep -q . "$HOME/.local/state/agent-kit/command.tsv" && fail "foreign launcher must not be owned"
	rm "$HOME/.local/bin/agent-kit"
	# b) identical symlink is adopted into ownership without changes
	ln -s "$SANDBOX/kit/bin/agent-kit" "$HOME/.local/bin/agent-kit"
run_install pi
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "identical launcher unchanged"
	grep -Fq "$HOME/.local/bin/agent-kit" "$HOME/.local/state/agent-kit/command.tsv" || fail "adopted launcher must be recorded"
	# c) owned then manually redirected: released, never overwritten
	ln -sfn "$SANDBOX/outside/other-command" "$HOME/.local/bin/agent-kit"
run_install pi
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/outside/other-command" "redirected launcher untouched"
	grep -Fq "$HOME/.local/bin/agent-kit" "$HOME/.local/state/agent-kit/command.tsv" && fail "ownership must be released"
pass

# ==============================================================================

# ==============================================================================
# T18: invoking the CLI through an arbitrary symlink must still root at the
# real checkout (covers non-launcher symlink paths end to end)

new_test "T18 symlinked CLI invocation"
use_path empty
make_kit "$SANDBOX/kit"
mkdir -p "$SANDBOX/cli"
ln -s "$SANDBOX/kit/bin/agent-kit" "$SANDBOX/cli/agent-kit"
PI_AGENT_DIR="$HOME/.pi/agent"
OMP_AGENT_DIR="$HOME/.omp/agent"
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
export PI_AGENT_DIR OMP_AGENT_DIR OPENCODE_CONFIG_DIR
unset AGENT_KIT_ROOT
	if OUT="$("$SANDBOX/cli/agent-kit" install pi omp opencode 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	assert_eq "$RC" 0 "exit code"
	assert_link "$HOME/.pi/agent/skills/alpha" "$SANDBOX/kit/shared/skills/alpha" "shared skill via symlinked CLI"
	assert_link "$HOME/.omp/agent/RULES.md" "$SANDBOX/kit/runtimes/omp/RULES.md" "omp root file via symlinked CLI"
	assert_eq "$(state_lines pi)" 6 "pi state entries"
	case "$OUT" in
	*"nothing to install"*) fail "symlinked CLI resolved the wrong repository root and desired nothing" ;;
	*) : ;;
	esac
pass

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
