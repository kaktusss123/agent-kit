#!/usr/bin/env bash
#
# Ownership-semantics tests for bin/agent-kit (Pi-only installer).
#
# Every test runs in a fresh sandbox: fake $HOME, and a minimal synthetic
# agent-kit tree. Nothing outside the sandbox is read or written (the real
# repository is only copied from, never modified).
#
# Usage: tests/installer/run.sh [-v]
#   -v  print installer output for each test
#
# Exit code: 0 when all tests pass, 1 otherwise.
set -euo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_REPO="$(cd "$SELF_DIR/.." && pwd -P)"
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

run_install() { # sets OUT and RC
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" install "$@" 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

run_install_from() { # <kit-dir> — sets OUT and RC
	if OUT="$(AGENT_KIT_ROOT="$1" "$1/bin/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

run_uninstall() { # sets OUT and RC
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" uninstall "$@" 2>&1)"; then RC=0; else RC=$?; fi
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
	unset XDG_STATE_HOME PI_AGENT_DIR AGENT_TASK_ROOT AGENT_KIT_ROOT 2>/dev/null || true
	STATE="$HOME/.local/state/agent-kit/links.tsv"
	CMD_STATE="$HOME/.local/state/agent-kit/command.tsv"
	PI_ROOT="$HOME/.pi/agent"
	LEGACY_OMP_ROOT="$HOME/.omp/agent"
	LEGACY_OC_ROOT="$HOME/.config/opencode"
}

cleanup() {
	[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && chmod -R u+w "$SANDBOX" 2>/dev/null || true
	rm -rf "$SANDBOX"
}
trap cleanup EXIT

use_path_empty() { PATH="/usr/bin:/bin"; export PATH; }

# Minimal synthetic checkout following the repository conventions.
make_kit() { # <checkout-dir>
	local d="$1"
	mkdir -p "$d/bin" \
		"$d/skills/alpha" "$d/skills/beta" \
		"$d/extensions/todo" \
		"$d/prompts"
	cp "$INSTALLER" "$d/bin/agent-kit"
	echo "# alpha" > "$d/skills/alpha/SKILL.md"
	echo "# beta" > "$d/skills/beta/SKILL.md"
	echo "export const x = 1" > "$d/extensions/todo/index.ts"
	echo "export const f = 1" > "$d/extensions/foot.ts"
	echo "spec" > "$d/prompts/spec.md"
	echo "dev" > "$d/prompts/dev.md"
}

state_entries() { # number of state entries
	[ -f "$STATE" ] || { printf 0; return; }
	grep -c . "$STATE" || true
}

legacy_entries() { # number of legacy-format (3+ field) lines in state
	[ -f "$STATE" ] || { printf 0; return; }
	awk -F '\t' 'NF >= 3' "$STATE" | grep -c . || true
}

outside_skill() { # a real directory outside any checkout
	mkdir -p "$SANDBOX/outside/real-skill"
	echo external > "$SANDBOX/outside/real-skill/SKILL.md"
}

# ==============================================================================
# T1: fresh install links every category, records ownership, bootstraps the
# launcher, and rejects runtime-style arguments

new_test "T1 fresh install"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "skill linked"
	assert_link "$PI_ROOT/skills/beta" "$SANDBOX/kit/skills/beta" "second skill linked"
	assert_link "$PI_ROOT/extensions/todo" "$SANDBOX/kit/extensions/todo" "extension dir linked"
	assert_link "$PI_ROOT/extensions/foot.ts" "$SANDBOX/kit/extensions/foot.ts" "extension file linked"
	assert_link "$PI_ROOT/prompts/spec.md" "$SANDBOX/kit/prompts/spec.md" "spec prompt linked"
	assert_link "$PI_ROOT/prompts/dev.md" "$SANDBOX/kit/prompts/dev.md" "dev prompt linked"
	assert_eq "$(state_entries)" 6 "state records every entity"
	assert_eq "$(legacy_entries)" 0 "state uses the current format"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "launcher bootstrapped"
	OUT="$(env -u AGENT_KIT_ROOT "$HOME/.local/bin/agent-kit" status 2>&1)"
	case "$OUT" in
	*"wants 6 entity"*) : ;;
	*) fail "bootstrapped launcher must resolve its own checkout, got: $OUT" ;;
	esac
	run_install pi
	assert_eq "$RC" 2 "runtime-style argument rejected"
	run_install omp
	assert_eq "$RC" 2 "retired runtime name rejected as argument"
run_uninstall
	assert_eq "$RC" 0 "uninstall"
	assert_no_file "$PI_ROOT/skills/alpha" "skill link removed"
	assert_no_file "$PI_ROOT/prompts/spec.md" "prompt link removed"
pass

# ==============================================================================
# T2: reinstall from the same checkout is idempotent

new_test "T2 idempotent reinstall"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "first install"
	STATE_BEFORE="$(cat "$STATE")"
	run_install
	assert_eq "$RC" 0 "second install"
	assert_eq "$(cat "$STATE")" "$STATE_BEFORE" "state unchanged"
	case "$OUT" in
	*"0 created, 0 relinked"*) : ;;
	*) fail "second install should change nothing, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T3: install from another checkout (worktree switch) repoints managed links
# only, and a category dropped from the repo is pruned

new_test "T3 checkout switch"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "base install"
	# second checkout: adds gamma, drops beta; prompts follow the same
	# ownership model as everything else and are repointed
	make_kit "$SANDBOX/kit2"
	rm -rf "$SANDBOX/kit2/skills/beta"
	mkdir -p "$SANDBOX/kit2/skills/gamma"
	echo "# gamma" > "$SANDBOX/kit2/skills/gamma/SKILL.md"
	echo "# alpha v2" > "$SANDBOX/kit2/skills/alpha/SKILL.md"
	run_install_from "$SANDBOX/kit2"
	assert_eq "$RC" 0 "switch install"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit2/skills/alpha" "alpha repointed"
	assert_link "$PI_ROOT/skills/gamma" "$SANDBOX/kit2/skills/gamma" "gamma created from kit2"
	assert_no_file "$PI_ROOT/skills/beta" "beta pruned"
	assert_link "$PI_ROOT/prompts/spec.md" "$SANDBOX/kit2/prompts/spec.md" "spec prompt repointed"
	assert_link "$PI_ROOT/prompts/dev.md" "$SANDBOX/kit2/prompts/dev.md" "dev prompt repointed"
	assert_eq "$(cat "$PI_ROOT/prompts/dev.md")" "dev" "prompt content follows the checkout"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit2/bin/agent-kit" "launcher repointed"
	assert_file "$SANDBOX/kit/skills/beta/SKILL.md" "old checkout files untouched"
	assert_eq "$(state_entries)" 6 "state tracks the kit2 set"
pass

# ==============================================================================
# T4: an unrelated external symlink in the destination is never touched

new_test "T4 foreign symlink untouched"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$PI_ROOT/skills"
	ln -s "$SANDBOX/outside/real-skill" "$PI_ROOT/skills/external"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_ROOT/skills/external" "$SANDBOX/outside/real-skill" "foreign link kept"
	grep -q "skills/external" "$STATE" && fail "foreign link must not be in state"
run_uninstall
	assert_link "$PI_ROOT/skills/external" "$SANDBOX/outside/real-skill" "foreign link survives uninstall"
pass

# ==============================================================================
# T5: a real file/dir at a desired target is never overwritten

new_test "T5 real file conflict"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$PI_ROOT/skills/alpha"
	echo mine > "$PI_ROOT/skills/alpha/SKILL.md"
run_install
	assert_eq "$RC" 1 "conflict fails the install"
	assert_file "$PI_ROOT/skills/alpha/SKILL.md" "user file intact"
	assert_eq "$(cat "$PI_ROOT/skills/alpha/SKILL.md")" "mine" "content intact"
	grep -q "skills/alpha" "$STATE" && fail "conflicted path must not be owned"
	case "$OUT" in
	*"not a symlink"*) : ;;
	*) fail "should explain the real-file conflict" ;;
	esac
run_uninstall
	assert_file "$PI_ROOT/skills/alpha/SKILL.md" "user file survives uninstall"
pass

# ==============================================================================
# T6: a managed link redirected by the user is never deleted or replaced

new_test "T6 redirected managed link"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$SANDBOX/outside/other"
	echo redirect > "$SANDBOX/outside/other/SKILL.md"
run_install
	assert_eq "$RC" 0 "base install"
	ln -sfn "$SANDBOX/outside/other" "$PI_ROOT/skills/alpha"
run_install
	assert_eq "$RC" 1 "conflict reported"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/outside/other" "redirected link untouched"
	awk -F '\t' '$1 == "skills/alpha"' "$STATE" | grep -q . && fail "ownership must be released"
run_uninstall
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/outside/other" "uninstall leaves redirected link"
pass

# ==============================================================================
# T7: an item removed from the repo is cleaned up on the next install

new_test "T7 removed item pruned"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "base install"
	rm -rf "$SANDBOX/kit/skills/beta"
run_install
	assert_eq "$RC" 0 "reconcile install"
	assert_no_file "$PI_ROOT/skills/beta" "removed item link deleted"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "other links intact"
	assert_eq "$(state_entries)" 5 "state entry cleaned"
pass

# ==============================================================================
# T8: same, but the user already replaced the link — it must survive

new_test "T8 removed item with redirected link"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
run_install
	assert_eq "$RC" 0 "base install"
	rm -rf "$SANDBOX/kit/skills/beta"
	ln -sfn "$SANDBOX/outside/real-skill" "$PI_ROOT/skills/beta"
run_install
	assert_eq "$RC" 0 "reconcile succeeds (only a forget note)"
	assert_link "$PI_ROOT/skills/beta" "$SANDBOX/outside/real-skill" "user link untouched"
	awk -F '\t' '$1 == "skills/beta"' "$STATE" | grep -q . && fail "ownership must be forgotten"
pass

# ==============================================================================
# T9: uninstall removes only provably owned links

new_test "T9 uninstall scope"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$PI_ROOT/skills"
	ln -s "$SANDBOX/outside/real-skill" "$PI_ROOT/skills/external"
run_install
	assert_eq "$RC" 0 "base install"
run_uninstall
	assert_eq "$RC" 0 "uninstall"
	assert_no_file "$PI_ROOT/skills/alpha" "owned skill link removed"
	assert_no_file "$PI_ROOT/extensions/todo" "owned extension removed"
	assert_link "$PI_ROOT/skills/external" "$SANDBOX/outside/real-skill" "foreign link kept"
	assert_eq "$(state_entries)" 0 "state cleaned"
pass

# ==============================================================================
# T10: corrupt/stale state must not authorize deleting user paths

new_test "T10 corrupt state safety"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "base install"
	# poison the state: a real user file claimed as managed, plus garbage
	mkdir -p "$(dirname "$STATE")"
	{
		printf 'skills/alpha\t%s/important-user-file\n' "$HOME"
		printf 'garbage line without tabs\n'
		printf 'totally\t\n'
		printf '\n'
		printf '../../etc/passwd\t/nowhere\n'
	} > "$STATE"
	echo precious > "$HOME/important-user-file"
run_uninstall
	assert_eq "$RC" 0 "uninstall survives corrupt state"
	assert_file "$HOME/important-user-file" "claimed-but-not-owned file must survive"
	case "$OUT" in
	*"released skills/alpha"*) : ;;
	*) fail "claimed file should be released, not deleted" ;;
	esac
run_install
	assert_eq "$RC" 0 "install survives corrupt state"
	assert_file "$HOME/important-user-file" "file still intact after install"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "install rebuilt the real link"
	grep -q "etc/passwd" "$STATE" && fail "path-traversal state entry must be dropped"
pass

# ==============================================================================
# T11: poisoned traversal state must not authorize deleting a path outside
# the Pi root (state says ../../victim -> recorded source)

new_test "T11 poisoned traversal state"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$SANDBOX/outside/target"
	echo victim-skill > "$SANDBOX/outside/target/SKILL.md"
run_install
	assert_eq "$RC" 0 "base install"
	ln -s "$SANDBOX/outside/target" "$HOME/victim"
	printf '../../victim\t%s\n' "$SANDBOX/outside/target" > "$STATE"
run_uninstall
	assert_eq "$RC" 0 "uninstall survives poisoned state"
	assert_link "$HOME/victim" "$SANDBOX/outside/target" "symlink outside the Pi root survives"
	case "$OUT" in
	*"ignoring invalid state line"*) : ;;
	*) fail "traversal state line must be dropped with a warning" ;;
	esac
run_install
	assert_eq "$RC" 0 "install survives poisoned state"
	assert_link "$HOME/victim" "$SANDBOX/outside/target" "victim still intact after install"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "real links rebuilt normally"
pass

# ==============================================================================
# T12: spaces in XDG state and Pi-root paths

new_test "T12 paths with spaces"
use_path_empty
make_kit "$SANDBOX/kit"
	SANDBOX_SPACES="$SANDBOX/Some Folder (v2)"
	mkdir -p "$SANDBOX_SPACES/home"
	HOME="$SANDBOX_SPACES/home"
	XDG_STATE_HOME="$SANDBOX_SPACES/my state"
	PI_AGENT_DIR="$SANDBOX_SPACES/pi agent"
	export HOME XDG_STATE_HOME PI_AGENT_DIR
	STATE="$XDG_STATE_HOME/agent-kit/links.tsv"
	PI_ROOT="$PI_AGENT_DIR"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "link in spaced root"
	assert_file "$STATE" "state in spaced XDG path"
run_uninstall
	assert_no_file "$PI_ROOT/skills/alpha" "cleanup works with spaced paths"
pass

# ==============================================================================
# T13: install bootstraps ~/.local/bin/agent-kit, repoints it on checkout
# switch, and leaves a real file at the launcher path alone

new_test "T13 launcher bootstrap and switch"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "base install"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "launcher points at this checkout"
	make_kit "$SANDBOX/kit2"
	run_install_from "$SANDBOX/kit2"
	assert_eq "$RC" 0 "install from kit2"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit2/bin/agent-kit" "launcher repointed to kit2"
	rm "$HOME/.local/bin/agent-kit"
	echo custom-script > "$HOME/.local/bin/agent-kit"
	run_install_from "$SANDBOX/kit"
	assert_eq "$RC" 0 "real launcher file is a warning, not a failure"
	assert_eq "$(cat "$HOME/.local/bin/agent-kit")" "custom-script" "user launcher file untouched"
	case "$OUT" in
	*"command bootstrap skipped"*) : ;;
	*) fail "should warn about skipping the bootstrap" ;;
	esac
pass

# ==============================================================================
# T14: the launcher is owned via its own record; foreign symlinks at
# ~/.local/bin/agent-kit are never touched or adopted blindly

new_test "T14 launcher ownership"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$HOME/.local/bin" "$SANDBOX/outside"
	printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/outside/other-command"
	chmod +x "$SANDBOX/outside/other-command"
	# a) foreign symlink: untouched, not adopted
	ln -s "$SANDBOX/outside/other-command" "$HOME/.local/bin/agent-kit"
run_install
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/outside/other-command" "foreign launcher untouched"
	case "$OUT" in
	*"not managed by agent-kit; command bootstrap skipped"*) : ;;
	*) fail "foreign launcher should be reported" ;;
	esac
	[ -f "$CMD_STATE" ] && grep -q . "$CMD_STATE" && fail "foreign launcher must not be owned"
	rm "$HOME/.local/bin/agent-kit"
	# b) identical symlink is adopted into ownership without changes
	ln -s "$SANDBOX/kit/bin/agent-kit" "$HOME/.local/bin/agent-kit"
run_install
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "identical launcher unchanged"
	grep -Fq "$HOME/.local/bin/agent-kit" "$CMD_STATE" || fail "adopted launcher must be recorded"
	# c) owned then manually redirected: released, never overwritten
	ln -sfn "$SANDBOX/outside/other-command" "$HOME/.local/bin/agent-kit"
run_install
	assert_eq "$RC" 0 "install succeeds"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/outside/other-command" "redirected launcher untouched"
	grep -Fq "$HOME/.local/bin/agent-kit" "$CMD_STATE" && fail "ownership must be released"
pass

# ==============================================================================
# T15: invoking the CLI through an arbitrary symlink must still root at the
# real checkout

new_test "T15 symlinked CLI invocation"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$SANDBOX/cli"
	ln -s "$SANDBOX/kit/bin/agent-kit" "$SANDBOX/cli/agent-kit"
	if OUT="$("$SANDBOX/cli/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "skill via symlinked CLI"
	case "$OUT" in
	*"nothing to install"*) fail "symlinked CLI resolved the wrong repository root and desired nothing" ;;
	*) : ;;
	esac
pass

# ==============================================================================
# T16: legacy multi-runtime state is migrated once on install: owned links of
# retired runtimes are removed, foreign ones released, own rows converted

new_test "T16 legacy state migration on install"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	# legacy omp link agent-kit provably owns (target == recorded source)
	mkdir -p "$LEGACY_OMP_ROOT/skills" "$LEGACY_OMP_ROOT/extensions"
	ln -s "$SANDBOX/kit/skills/beta" "$LEGACY_OMP_ROOT/skills/beta"
	# legacy opencode link redirected by the user after install — must survive
	mkdir -p "$LEGACY_OC_ROOT/skills"
	ln -s "$SANDBOX/outside/real-skill" "$LEGACY_OC_ROOT/skills/git-commit"
	# legacy pi row whose target still matches: keep owning it after migration
	mkdir -p "$PI_ROOT/skills"
	ln -s "$SANDBOX/kit/skills/alpha" "$PI_ROOT/skills/alpha"
	mkdir -p "$(dirname "$STATE")"
	{
		printf 'omp\tskills/beta\t%s\n' "$SANDBOX/kit/skills/beta"
		printf 'opencode\tskills/git-commit\t/some/old/opencode/checkout/skills/git-commit\n'
		printf 'pi\tskills/alpha\t%s\n' "$SANDBOX/kit/skills/alpha"
		printf 'bogus-runtime\tskills/x\t/nowhere\n'
	} > "$STATE"
run_install
	assert_eq "$RC" 0 "exit code"
	case "$OUT" in
	*"legacy omp: removed skills/beta"*) : ;;
	*) fail "provably-owned legacy link must be removed, got: $OUT" ;;
	esac
	assert_no_file "$LEGACY_OMP_ROOT/skills/beta" "owned legacy omp link removed"
	assert_link "$LEGACY_OC_ROOT/skills/git-commit" "$SANDBOX/outside/real-skill" "redirected legacy link untouched"
	case "$OUT" in
	*"ignoring state line for unknown legacy runtime"*) : ;;
	*) fail "unknown legacy runtime row must be dropped with a warning" ;;
	esac
	assert_eq "$(legacy_entries)" 0 "state converted to the current format"
	awk -F '\t' '$1 == "skills/alpha"' "$STATE" | grep -q . || fail "own pi row must survive migration as owned"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "own link kept through migration"
	run_install
	case "$OUT" in
	*legacy*) fail "migration must be one-time, got: $OUT" ;;
	*) : ;;
	esac
	assert_eq "$(state_entries)" 6 "state stable after migration"
pass

# ==============================================================================
# T17: uninstall also retires legacy owned links of retired runtimes

new_test "T17 uninstall with legacy state"
use_path_empty
make_kit "$SANDBOX/kit"
outside_skill
	mkdir -p "$LEGACY_OMP_ROOT/skills"
	ln -s "$SANDBOX/kit/skills/beta" "$LEGACY_OMP_ROOT/skills/beta"
	ln -s "$SANDBOX/outside/real-skill" "$LEGACY_OMP_ROOT/skills/external"
	mkdir -p "$(dirname "$STATE")"
	{
		printf 'skills/alpha\t%s\n' "$SANDBOX/kit/skills/alpha"
		printf 'omp\tskills/beta\t%s\n' "$SANDBOX/kit/skills/beta"
		printf 'omp\tskills/external\t/some/old/checkout/skills/external\n'
	} > "$STATE"
run_uninstall
	assert_eq "$RC" 0 "exit code"
	assert_no_file "$PI_ROOT/skills/alpha" "owned pi link removed"
	assert_no_file "$LEGACY_OMP_ROOT/skills/beta" "owned legacy link removed"
	assert_link "$LEGACY_OMP_ROOT/skills/external" "$SANDBOX/outside/real-skill" "foreign legacy link untouched"
	assert_eq "$(state_entries)" 0 "state emptied"
pass

# ==============================================================================
# T18: missing runtime binaries do not matter — there is no autodetection

new_test "T18 no autodetection"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "install works without any runtime binary in PATH"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "link created"
	case "$OUT" in
	*Detected:*|*Skipped:*) fail "installer must not detect or skip runtimes, got: $OUT" ;;
	*) : ;;
	esac
pass

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
