#!/usr/bin/env bash
#
# Ownership-semantics tests for bin/agent-kit (installer for the pi and
# claude-code hosts).
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

run_update() { # sets OUT and RC
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" update 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}

git_commit_all() { # <repo> <message> — commit every change with a fixed identity
	git -C "$1" add -A
	git -C "$1" -c user.email=agent-kit@test -c user.name=agent-kit commit -qm "$2"
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
	# The whole executable tree: the entrypoint imports its modules from bin/lib,
	# and `snapshot` is delegated to the temporary Bash writer next to it.
	cp -R "$REAL_REPO/bin/." "$d/bin/"
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
# launcher, and rejects retired runtime names as host arguments

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

# ==============================================================================
# T19: rules/AGENTS.md is installed as AGENTS.md at the Pi root and follows the
# generic ownership model (status, prune-on-removal, uninstall)

new_test "T19 root AGENTS.md file"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$SANDBOX/kit/rules"
	printf '# agent rules\n' > "$SANDBOX/kit/rules/AGENTS.md"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_link "$PI_ROOT/AGENTS.md" "$SANDBOX/kit/rules/AGENTS.md" "root AGENTS.md linked"
	assert_eq "$(state_entries)" 7 "state records the root file"
	OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" status 2>&1)"
	case "$OUT" in
	*"7 managed — 7 up to date"*) : ;;
	*) fail "status should report the root file up to date, got: $OUT" ;;
	esac
	# removing the file from the repo prunes the link through the same
	# generic ownership path as any other entity
	rm "$SANDBOX/kit/rules/AGENTS.md"
run_install
	assert_eq "$RC" 0 "reconcile install"
	assert_no_file "$PI_ROOT/AGENTS.md" "root file pruned once gone from the repo"
	assert_eq "$(state_entries)" 6 "state entry cleaned"
run_uninstall
	assert_eq "$RC" 0 "uninstall"
	assert_no_file "$PI_ROOT/skills/alpha" "owned skill link removed"
pass

# ==============================================================================
# T20: a real file at the AGENTS.md destination is a conflict, never overwritten

new_test "T20 real AGENTS.md conflict"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$SANDBOX/kit/rules" "$PI_ROOT"
	printf '# agent rules\n' > "$SANDBOX/kit/rules/AGENTS.md"
	printf 'mine\n' > "$PI_ROOT/AGENTS.md"
run_install
	assert_eq "$RC" 1 "conflict fails the install"
	assert_eq "$(cat "$PI_ROOT/AGENTS.md")" "mine" "user file intact"
	awk -F '\t' '$1 == "AGENTS.md"' "$STATE" | grep -q . && fail "conflicted root file must not be owned"
	case "$OUT" in
	*"not a symlink"*) : ;;
	*) fail "should explain the real-file conflict" ;;
	esac
run_uninstall
	assert_eq "$(cat "$PI_ROOT/AGENTS.md")" "mine" "user file survives uninstall"
pass

# ==============================================================================
# T21: update fast-forwards the checkout and reconciles links to the new tree

new_test "T21 update fast-forward and reconcile"
make_kit "$SANDBOX/seed"
git -C "$SANDBOX/seed" init -q -b main
git_commit_all "$SANDBOX/seed" init
git init --bare -q -b main "$SANDBOX/origin.git"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
git clone -q "$SANDBOX/origin.git" "$SANDBOX/kit"
run_install_from "$SANDBOX/kit"
	assert_eq "$RC" 0 "install from cloned checkout"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "alpha linked before update"
# a new entity lands upstream while the checkout stays behind
mkdir -p "$SANDBOX/seed/skills/gamma"
echo "# gamma" > "$SANDBOX/seed/skills/gamma/SKILL.md"
git_commit_all "$SANDBOX/seed" "add gamma"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
run_update
	assert_eq "$RC" 0 "update succeeds"
	[ "$(git -C "$SANDBOX/kit" rev-parse HEAD)" = "$(git -C "$SANDBOX/seed" rev-parse HEAD)" ] || fail "checkout should sit at the pushed upstream commit"
	assert_link "$PI_ROOT/skills/gamma" "$SANDBOX/kit/skills/gamma" "new entity linked by the update reconcile"
# nothing new upstream: still clean, reconcile idempotent
run_update
	assert_eq "$RC" 0 "update without new commits succeeds"
pass

# ==============================================================================
# T22: update refuses to clobber a diverged checkout and changes nothing

new_test "T22 update refuses a diverged checkout"
make_kit "$SANDBOX/seed"
git -C "$SANDBOX/seed" init -q -b main
git_commit_all "$SANDBOX/seed" init
git init --bare -q -b main "$SANDBOX/origin.git"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
git clone -q "$SANDBOX/origin.git" "$SANDBOX/kit"
run_install_from "$SANDBOX/kit"
# upstream moves one way, the checkout moves the other
mkdir -p "$SANDBOX/seed/skills/gamma"
echo "# gamma" > "$SANDBOX/seed/skills/gamma/SKILL.md"
git_commit_all "$SANDBOX/seed" "add gamma upstream"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
mkdir -p "$SANDBOX/kit/skills/delta"
echo "# delta" > "$SANDBOX/kit/skills/delta/SKILL.md"
git_commit_all "$SANDBOX/kit" "add delta locally"
run_update
	assert_eq "$RC" 2 "diverged checkout fails the update"
	assert_no_file "$PI_ROOT/skills/gamma" "upstream entity not linked on failed update"
	assert_no_file "$PI_ROOT/skills/delta" "local-only entity never linked"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "existing links untouched"
	case "$OUT" in
	*"resolve it manually"*) : ;;
	*) fail "should explain the pull failure, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T23: update fails cleanly without a git checkout or without an upstream

new_test "T23 update without checkout or upstream"
use_path_empty
make_kit "$SANDBOX/kit"
run_update
	assert_eq "$RC" 2 "plain directory fails the update"
	case "$OUT" in
	*"is not a git checkout"*) : ;;
	*) fail "should explain the missing checkout, got: $OUT" ;;
	esac
git -C "$SANDBOX/kit" init -q
git_commit_all "$SANDBOX/kit" init
run_update
	assert_eq "$RC" 2 "repository without upstream fails the update"
	case "$OUT" in
	*"has no upstream"*) : ;;
	*) fail "should explain the missing upstream, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T24: the claude-code host gets skills and rules, with its own ownership state

new_test "T24 claude-code host"
use_path_empty
make_kit "$SANDBOX/kit"
	CLAUDE_ROOT="$HOME/.claude"
	CLAUDE_STATE="$HOME/.local/state/agent-kit/links-claude-code.tsv"
	mkdir -p "$SANDBOX/kit/rules"
	printf '# agent rules\n' > "$SANDBOX/kit/rules/AGENTS.md"
	printf '# claude mapping\n' > "$SANDBOX/kit/rules/claude-code.md"
run_install
	assert_eq "$RC" 0 "exit code"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "skill linked into claude"
	assert_link "$CLAUDE_ROOT/rules/agent-kit.md" "$SANDBOX/kit/rules/AGENTS.md" "AGENTS.md linked as a claude rule"
	assert_link "$CLAUDE_ROOT/rules/agent-kit-claude-code.md" "$SANDBOX/kit/rules/claude-code.md" "claude mapping rule linked"
	assert_no_file "$CLAUDE_ROOT/extensions" "no extensions for claude"
	assert_no_file "$CLAUDE_ROOT/prompts" "no pi prompts for claude"
	assert_no_file "$PI_ROOT/rules" "claude rules stay out of pi"
	assert_eq "$(grep -c . "$CLAUDE_STATE")" 4 "claude state records its own entities"
	awk -F '\t' '$1 ~ /^rules\//' "$STATE" | grep -q . && fail "pi state must not record claude entities"
run_uninstall
	assert_eq "$RC" 0 "uninstall"
	assert_no_file "$CLAUDE_ROOT/skills/alpha" "claude skill link removed"
	assert_no_file "$CLAUDE_ROOT/rules/agent-kit.md" "claude rule link removed"
	assert_no_file "$PI_ROOT/skills/alpha" "pi skill link removed"
pass

# ==============================================================================
# T25: CLAUDE_CONFIG_DIR relocates the claude-code root; a pre-existing link
# that already points at the checkout is adopted, a foreign file is a conflict

new_test "T25 claude-code root override and adoption"
use_path_empty
make_kit "$SANDBOX/kit"
	export CLAUDE_CONFIG_DIR="$SANDBOX/claude conf"
	mkdir -p "$CLAUDE_CONFIG_DIR/skills"
	ln -s "$SANDBOX/kit/skills/alpha" "$CLAUDE_CONFIG_DIR/skills/alpha"
	mkdir "$CLAUDE_CONFIG_DIR/skills/beta"
run_install
	unset CLAUDE_CONFIG_DIR
	assert_eq "$RC" 1 "foreign directory is a conflict"
	assert_link "$SANDBOX/claude conf/skills/alpha" "$SANDBOX/kit/skills/alpha" "matching link adopted"
	[ -d "$SANDBOX/claude conf/skills/beta" ] && [ ! -L "$SANDBOX/claude conf/skills/beta" ] || fail "foreign dir untouched"
	assert_no_file "$HOME/.claude" "default claude root unused when overridden"
	grep -q "skills/alpha" "$HOME/.local/state/agent-kit/links-claude-code.tsv" || fail "adopted link is owned"
pass

# ==============================================================================
# T26: update reconciles with the installer the pull brought, not the one
# that was running before it (A9 W0)

new_test "T26 update runs the freshly pulled installer"
make_kit "$SANDBOX/seed"
git -C "$SANDBOX/seed" init -q -b main
git_commit_all "$SANDBOX/seed" init
git init --bare -q -b main "$SANDBOX/origin.git"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
git clone -q "$SANDBOX/origin.git" "$SANDBOX/kit"
run_install_from "$SANDBOX/kit"
	assert_eq "$RC" 0 "install from cloned checkout"
# upstream replaces the installer with one that announces itself, so the test
# observes which file the update executes rather than which code it loaded
echo '#!/bin/sh' > "$SANDBOX/seed/bin/agent-kit"
echo 'echo "fresh installer reconcile"' >> "$SANDBOX/seed/bin/agent-kit"
chmod +x "$SANDBOX/seed/bin/agent-kit"
git_commit_all "$SANDBOX/seed" "change installer"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
run_update
	assert_eq "$RC" 0 "update succeeds"
	case "$OUT" in
	*"fresh installer reconcile"*) : ;;
	*) fail "reconcile must run the pulled installer, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T27: the claude-code host gets the agent-kit plugin (skills-directory
# plugin, linked as one directory) and the commands, with ownership

new_test "T27 claude-code plugin and commands"
use_path_empty
make_kit "$SANDBOX/kit"
	CLAUDE_ROOT="$HOME/.claude"
	CLAUDE_STATE="$HOME/.local/state/agent-kit/links-claude-code.tsv"
	mkdir -p "$SANDBOX/kit/claude-code/plugin/.claude-plugin" "$SANDBOX/kit/claude-code/commands"
	printf '{"name":"agent-kit"}\n' > "$SANDBOX/kit/claude-code/plugin/.claude-plugin/plugin.json"
	printf 'spec\n' > "$SANDBOX/kit/claude-code/commands/spec.md"
	printf 'dev\n' > "$SANDBOX/kit/claude-code/commands/dev.md"
	mkdir -p "$CLAUDE_ROOT/commands"
	printf 'mine\n' > "$CLAUDE_ROOT/commands/dev.md"
run_install
	assert_eq "$RC" 1 "user command file is a conflict"
	assert_link "$CLAUDE_ROOT/skills/agent-kit" "$SANDBOX/kit/claude-code/plugin" "plugin dir linked under skills/"
	assert_link "$CLAUDE_ROOT/commands/spec.md" "$SANDBOX/kit/claude-code/commands/spec.md" "spec command linked"
	assert_eq "$(cat "$CLAUDE_ROOT/commands/dev.md")" "mine" "user command untouched"
	awk -F "\t" '$1 == "skills/agent-kit"' "$CLAUDE_STATE" | grep -q . || fail "plugin link owned"
	assert_no_file "$PI_ROOT/skills/agent-kit" "plugin stays out of pi"
	assert_no_file "$PI_ROOT/commands" "commands stay out of pi"
run_uninstall
	assert_no_file "$CLAUDE_ROOT/skills/agent-kit" "plugin link removed on uninstall"
	assert_no_file "$CLAUDE_ROOT/commands/spec.md" "command link removed on uninstall"
	assert_eq "$(cat "$CLAUDE_ROOT/commands/dev.md")" "mine" "user command survives uninstall"
pass

# ==============================================================================
# T27b: claude-code agents are linked into agents/; a user's plain file with
# the same name is a conflict and stays untouched; pi never gets them

new_test "T27b claude-code agents"
use_path_empty
make_kit "$SANDBOX/kit"
	CLAUDE_ROOT="$HOME/.claude"
	mkdir -p "$SANDBOX/kit/claude-code/agents"
	printf 'explore\n' > "$SANDBOX/kit/claude-code/agents/Explore.md"
	printf 'owner\n' > "$SANDBOX/kit/claude-code/agents/repo-owner.md"
	mkdir -p "$CLAUDE_ROOT/agents"
	printf 'mine\n' > "$CLAUDE_ROOT/agents/Explore.md"
run_install
	assert_eq "$RC" 1 "user agent file is a conflict"
	assert_link "$CLAUDE_ROOT/agents/repo-owner.md" "$SANDBOX/kit/claude-code/agents/repo-owner.md" "repo-owner agent linked"
	assert_eq "$(cat "$CLAUDE_ROOT/agents/Explore.md")" "mine" "user agent untouched"
	assert_no_file "$PI_ROOT/agents" "agents stay out of pi"
run_uninstall
	assert_no_file "$CLAUDE_ROOT/agents/repo-owner.md" "agent link removed on uninstall"
	assert_eq "$(cat "$CLAUDE_ROOT/agents/Explore.md")" "mine" "user agent survives uninstall"
pass

# ==============================================================================
# Host selection: install/uninstall take host names; the selection is
# remembered in $XDG_STATE_HOME/agent-kit/hosts and reused by bare install
# and update.

use_selection_paths() {
	CLAUDE_ROOT="$HOME/.claude"
	CLAUDE_STATE="$HOME/.local/state/agent-kit/links-claude-code.tsv"
	SELECTION="$HOME/.local/state/agent-kit/hosts"
}

# ==============================================================================
# T28: install claude-code on a fresh machine links only Claude Code and
# records the selection; a following bare install keeps it

new_test "T28 install a single host"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_install claude-code
	assert_eq "$RC" 0 "exit code"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude skill linked"
	assert_no_file "$PI_ROOT" "pi root untouched"
	assert_eq "$(state_entries)" 0 "no pi ownership recorded"
	assert_eq "$(cat "$SELECTION")" "claude-code" "selection records claude-code"
	assert_link "$HOME/.local/bin/agent-kit" "$SANDBOX/kit/bin/agent-kit" "launcher bootstrapped"
run_install
	assert_eq "$RC" 0 "bare install"
	assert_no_file "$PI_ROOT" "bare install keeps pi unselected"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude link kept"
	assert_eq "$(cat "$SELECTION")" "claude-code" "selection unchanged"
pass

# ==============================================================================
# T29: install pi adds Pi to the selection; uninstall pi removes only Pi's
# links and its selection entry

new_test "T29 add and remove a host"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_install claude-code
	assert_eq "$RC" 0 "claude-code install"
run_install pi
	assert_eq "$RC" 0 "pi install"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "pi skill linked"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude skill still linked"
	assert_eq "$(sort "$SELECTION" | tr '\n' ' ')" "claude-code pi " "selection holds both hosts"
run_uninstall pi
	assert_eq "$RC" 0 "uninstall pi"
	assert_no_file "$PI_ROOT/skills/alpha" "pi link removed"
	assert_eq "$(state_entries)" 0 "pi ownership cleared"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude link untouched"
	assert_eq "$(cat "$SELECTION")" "claude-code" "pi dropped from the selection"
run_install
	assert_no_file "$PI_ROOT/skills/alpha" "bare install does not bring pi back"
pass

# ==============================================================================
# T30: bare uninstall removes every host's links and the selection file; an
# emptied selection behaves like a fresh machine on the next bare install

new_test "T30 uninstall everything"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_install pi
	assert_eq "$RC" 0 "pi install"
run_uninstall pi
	assert_eq "$(grep -c . "$SELECTION" || true)" 0 "selection emptied, file kept"
run_install
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "empty selection: pi installed"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "empty selection: claude installed"
run_uninstall
	assert_eq "$RC" 0 "bare uninstall"
	assert_no_file "$PI_ROOT/skills/alpha" "pi link removed"
	assert_no_file "$CLAUDE_ROOT/skills/alpha" "claude link removed"
	assert_no_file "$SELECTION" "selection file removed"
pass

# ==============================================================================
# T31: an unknown host name fails with exit 2 before anything changes

new_test "T31 unknown host"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_install claude-code
	assert_eq "$RC" 0 "claude-code install"
	SEL_BEFORE="$(cat "$SELECTION")"
	CLAUDE_STATE_BEFORE="$(cat "$CLAUDE_STATE")"
run_install pi bogus
	assert_eq "$RC" 2 "install with an unknown host"
	assert_no_file "$PI_ROOT" "valid host in the same call not installed"
	assert_eq "$(cat "$SELECTION")" "$SEL_BEFORE" "selection unchanged"
run_install "pi claude-code"
	assert_eq "$RC" 2 "one argument naming two hosts is not a host"
	assert_no_file "$PI_ROOT" "pi still not installed"
run_uninstall claude-code bogus
	assert_eq "$RC" 2 "uninstall with an unknown host"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude link kept"
	assert_eq "$(cat "$CLAUDE_STATE")" "$CLAUDE_STATE_BEFORE" "claude state unchanged"
	assert_eq "$(cat "$SELECTION")" "$SEL_BEFORE" "selection still unchanged"
	case "$OUT" in
	*"unknown host"*) : ;;
	*) fail "should name the unknown host, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T32: an install made before host selection existed (both link state files,
# no selection file) keeps both hosts on a bare install; a link state file
# without valid rows does not count as selected

new_test "T32 legacy install without a selection file"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_install
	assert_eq "$RC" 0 "base install"
	rm "$SELECTION"
run_install
	assert_eq "$RC" 0 "bare install"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "pi kept"
	assert_link "$CLAUDE_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "claude kept"
	assert_eq "$(sort "$SELECTION" | tr '\n' ' ')" "claude-code pi " "derived selection recorded"
	# only claude-code has owned links; pi's state holds garbage
	rm "$SELECTION"
	rm -rf "$PI_ROOT"
	printf 'garbage line without tabs\n' > "$STATE"
run_install
	assert_eq "$RC" 0 "bare install with claude-only legacy state"
	assert_no_file "$PI_ROOT/skills/alpha" "pi not derived from invalid rows"
	assert_eq "$(cat "$SELECTION")" "claude-code" "only claude-code derived"
pass

# ==============================================================================
# T33: update keeps the recorded selection

new_test "T33 update honors the selection"
make_kit "$SANDBOX/seed"
git -C "$SANDBOX/seed" init -q -b main
git_commit_all "$SANDBOX/seed" init
git init --bare -q -b main "$SANDBOX/origin.git"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
git clone -q "$SANDBOX/origin.git" "$SANDBOX/kit"
use_selection_paths
run_install claude-code
	assert_eq "$RC" 0 "claude-code install"
mkdir -p "$SANDBOX/seed/skills/gamma"
echo "# gamma" > "$SANDBOX/seed/skills/gamma/SKILL.md"
git_commit_all "$SANDBOX/seed" "add gamma"
git -C "$SANDBOX/seed" push -q "$SANDBOX/origin.git" main
run_update
	assert_eq "$RC" 0 "update succeeds"
	assert_link "$CLAUDE_ROOT/skills/gamma" "$SANDBOX/kit/skills/gamma" "new entity linked into claude"
	assert_no_file "$PI_ROOT" "update keeps pi unselected"
	assert_eq "$(cat "$SELECTION")" "claude-code" "selection unchanged"
pass

# ==============================================================================
# T34: status reports where the selection comes from and marks unselected
# hosts; invalid selection lines are ignored with a warning

new_test "T34 status reports the selection"
use_path_empty
make_kit "$SANDBOX/kit"
use_selection_paths
run_status() {
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" status 2>&1)"; then RC=0; else RC=$?; fi
	[ "$VERBOSE" = 1 ] && printf '%s\n' "$OUT"
	return 0
}
run_status
	case "$OUT" in
	*"hosts: pi claude-code (default"*) : ;;
	*) fail "fresh status should report the default selection, got: $OUT" ;;
	esac
run_install claude-code
	printf 'omp\n' >> "$SELECTION"
run_status
	assert_eq "$RC" 0 "status exit code"
	case "$OUT" in
	*"hosts: claude-code (recorded"*) : ;;
	*) fail "status should report the recorded selection, got: $OUT" ;;
	esac
	case "$OUT" in
	*"pi root: $PI_ROOT (not selected)"*) : ;;
	*) fail "status should mark pi as not selected, got: $OUT" ;;
	esac
	case "$OUT" in
	*"ignoring invalid host selection line: omp"*) : ;;
	*) fail "invalid selection line should be reported, got: $OUT" ;;
	esac
	rm "$SELECTION"
run_status
	case "$OUT" in
	*"hosts: claude-code (derived"*) : ;;
	*) fail "status should report the derived selection, got: $OUT" ;;
	esac
pass


# ==============================================================================
# T35: state written by the previous installer (one extra trailing blank line)
# is read as-is, and the first rewrite drops it without losing ownership

new_test "T35 previous state format is read and normalized"
use_path_empty
make_kit "$SANDBOX/kit"
run_install
	assert_eq "$RC" 0 "base install"
	assert_eq "$(state_entries)" 6 "state records every entity"
# the previous implementation terminated every state file with a blank line
printf '\n' >> "$STATE"
OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" status 2>&1)"
	case "$OUT" in
	*"6 managed — 6 up to date"*) : ;;
	*) fail "old-format state must stay fully owned, got: $OUT" ;;
	esac
run_install
	assert_eq "$RC" 0 "reinstall on the old-format state"
	case "$OUT" in
	*"0 created, 0 relinked, 6 up to date"*) : ;;
	*) fail "reinstall must keep every link, got: $OUT" ;;
	esac
	[ -n "$(tail -1 "$STATE")" ] || fail "state must not end with a blank line after the rewrite"
	assert_eq "$(state_entries)" 6 "row count unchanged"
pass

# ==============================================================================
# T36: no command depends on a TTY: nothing prompts, and stdout carries no
# terminal escape sequences

new_test "T36 non-TTY output"
use_path_empty
make_kit "$SANDBOX/kit"
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" install </dev/null 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "install with stdin closed"
	case "$OUT" in
	*$'\033'*) fail "install printed an escape sequence in a non-TTY" ;;
	*) : ;;
	esac
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" status </dev/null 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "status with stdin closed"
	case "$OUT" in
	*$'\033'*) fail "status printed an escape sequence in a non-TTY" ;;
	*) : ;;
	esac
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" help </dev/null 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "help with stdin closed"
	case "$OUT" in
	*$'\033'*) fail "help printed an escape sequence in a non-TTY" ;;
	*) : ;;
	esac
pass

# ==============================================================================
# T37: the task wrapper hands its arguments to the task-workspace CLI verbatim,
# keeps stdout to one JSON object and propagates the runtime's exit code; the
# bun-less hook stays fail-open while an explicit operation reports the error

new_test "T37 task wrapper"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$SANDBOX/kit/extensions/task-workspace" "$SANDBOX/bin"
	printf 'export const x = 1\n' > "$SANDBOX/kit/extensions/task-workspace/cli.ts"
	# A stand-in for Bun that reports exactly what it was given: argv boundaries,
	# its own stdin and the exit code the wrapper must propagate.
	cat > "$SANDBOX/bin/bun" <<'EOB'
#!/usr/bin/env node
import { readFileSync } from "node:fs";
let stdin = "";
try {
	stdin = readFileSync(0, "utf8");
} catch {
	stdin = "";
}
process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`);
process.exit(Number(process.env.FAKE_BUN_EXIT ?? 0));
EOB
	chmod +x "$SANDBOX/bin/bun"
	NODE_DIR="$(dirname "$(command -v node)")"
	TASK_PATH="$SANDBOX/bin:$NODE_DIR:/usr/bin:/bin"
	run_task() { # <path> <argv...> — <path> is PATH for the call
		local path="$1"
		shift
		if OUT="$(PATH="$path" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task "$@" 2>&1)"; then RC=0; else RC=$?; fi
	}
	task_field() { # <field> — a field of the single JSON object on stdout
		printf '%s' "$OUT" | node -e '
			let text = "";
			process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
				process.stdout.write(JSON.stringify(JSON.parse(text)[process.argv[1]]));
			});
		' "$1"
	}
	CLI="$SANDBOX/kit/extensions/task-workspace/cli.ts"
	run_task "$TASK_PATH" status '{"path":"/tmp/x"}'
	assert_eq "$RC" 0 "task exit code"
	assert_eq "$(task_field argv)" "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$CLI" status '{"path":"/tmp/x"}')" "task argv and stdout"
	assert_eq "$(task_field stdin)" '""' "task leaves stdin to the runtime"
	assert_eq "$(printf '%s\n' "$OUT" | grep -c .)" 1 "task stdout is a single line"
	# stdin is the caller's: `-` reads the JSON request from it
	if OUT="$(printf '{"path":"/tmp/y"}' | PATH="$TASK_PATH" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task status - 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "task reads stdin"
	assert_eq "$(task_field stdin)" '"{\"path\":\"/tmp/y\"}"' "stdin request is passed through unchanged"
	assert_eq "$(task_field argv)" "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$CLI" status -)" "argv after a stdin request"
	FAKE_BUN_EXIT=3 run_task "$TASK_PATH" status -
	assert_eq "$RC" 3 "runtime exit code is propagated"
	# an empty PATH component means the current directory, as in a shell
	if OUT="$(cd "$SANDBOX/bin" && PATH=":$NODE_DIR:/usr/bin:/bin" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task status '{}' 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "empty PATH component finds ./bun"
	assert_eq "$(task_field argv)" "$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$CLI" status '{}')" "argv through a cwd lookup"
	# without bun: a hook fails open, an explicit operation fails as JSON
	if OUT="$(PATH="$NODE_DIR:/usr/bin:/bin" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task hook session-start 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "hook without bun fails open"
	assert_eq "$OUT" "" "hook without bun prints nothing"
	if OUT="$(PATH="$NODE_DIR:/usr/bin:/bin" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task status '{}' 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 1 "task without bun fails"
	assert_eq "$OUT" '{"status":"error","message":"agent-kit task requires bun on PATH"}' "task error JSON"
	assert_eq "$(printf '%s' "$OUT" | node -e 'let t="";process.stdin.on("data",(c)=>(t+=c)).on("end",()=>{JSON.parse(t);process.stdout.write("one object")})')" "one object" "error output is one JSON object"
	rm -rf "$SANDBOX/kit/extensions/task-workspace"
	if OUT="$(PATH="$TASK_PATH" AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" task status '{}' 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 1 "missing CLI fails"
	case "$OUT" in
	'{"status":"error","message":"task-workspace CLI missing: '*'"}') : ;;
	*) fail "missing CLI must be one JSON object, got: $OUT" ;;
	esac
pass

# ==============================================================================
# T38: snapshot is delegated to the temporary Bash writer, which validates its
# own arguments and the checkout before touching anything

new_test "T38 snapshot delegation"
use_path_empty
make_kit "$SANDBOX/kit"
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" snapshot 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 2 "snapshot without a releases dir is refused"
	case "$OUT" in
	*"snapshot takes exactly one argument"*) : ;;
	*) fail "expected the snapshot usage error, got: $OUT" ;;
	esac
	if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit" "$SANDBOX/kit/bin/agent-kit" snapshot "$SANDBOX/releases" 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 2 "snapshot of a non-git checkout is refused"
	case "$OUT" in
	*"is not a git checkout"*) : ;;
	*) fail "expected the non-git refusal, got: $OUT" ;;
	esac
	assert_no_file "$SANDBOX/releases" "refusal creates nothing"
pass

# ==============================================================================
# T39: the CLI works from a checkout whose path contains spaces

new_test "T39 spaced checkout path"
use_path_empty
	SPACED="$SANDBOX/Agent Kit (v2)"
make_kit "$SPACED"
if OUT="$(AGENT_KIT_ROOT="$SPACED" "$SPACED/bin/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "install from a spaced checkout"
	assert_link "$PI_ROOT/skills/alpha" "$SPACED/skills/alpha" "link into a spaced checkout"
	assert_eq "$(state_entries)" 6 "state records the spaced sources"
if OUT="$(AGENT_KIT_ROOT="$SPACED" "$SPACED/bin/agent-kit" uninstall 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "uninstall from a spaced checkout"
	assert_no_file "$PI_ROOT/skills/alpha" "spaced checkout links removed"
pass

# ==============================================================================
# T40: a fresh checkout installs without node_modules, a build step or network
# access; the committed executable tree is self-contained Node ESM

new_test "T40 fresh checkout without dependencies"
use_path_empty
make_kit "$SANDBOX/kit"
	[ -e "$SANDBOX/kit/node_modules" ] && fail "fixture must not carry node_modules"
	head -1 "$SANDBOX/kit/bin/agent-kit" | grep -qx '#!/usr/bin/env node' || fail "entrypoint must be a Node script"
	grep -q '"type": "module"' "$SANDBOX/kit/bin/package.json" || fail "entrypoint tree must declare ESM"
	# no dependency outside the Node standard library and relative modules
	if grep -rhE 'from "[^.]' "$SANDBOX/kit/bin/agent-kit" "$SANDBOX/kit/bin/lib" \
		| grep -vE 'from "node:' > "$SANDBOX/imports"; then
		fail "installer must only import node: builtins and relative modules: $(cat "$SANDBOX/imports")"
	fi
run_install
	assert_eq "$RC" 0 "install without node_modules"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "links created"
pass


# ==============================================================================
# T41: a recorded row can never name a different path than it contains, and an
# entity whose name breaks the line-based record is not installable, so state
# cannot widen what agent-kit is allowed to delete

new_test "T41 state cannot widen the owned path set"
use_path_empty
make_kit "$SANDBOX/kit"
	mkdir -p "$SANDBOX/outside/target"
	printf 'external\n' > "$SANDBOX/outside/target/SKILL.md"
	mkdir -p "$PI_ROOT"
	ln -s "$SANDBOX/outside/target" "$PI_ROOT/victim"
run_install
	assert_eq "$RC" 0 "base install"
	# a row whose destination normalizes to a different path (trailing "/.")
	printf 'victim/.\t%s\n' "$SANDBOX/kit/skills/alpha" > "$STATE"
run_uninstall
	assert_eq "$RC" 0 "uninstall with a non-normalized row"
	assert_link "$PI_ROOT/victim" "$SANDBOX/outside/target" "non-normalized row never authorizes a delete"
	case "$OUT" in
	*"ignoring invalid state line: victim/."*) : ;;
	*) fail "non-normalized row should be dropped with a warning, got: $OUT" ;;
	esac
	# an entity name carrying a newline would split one record into two rows,
	# the second of which would claim a path the repository never wanted
	rm -rf "$PI_ROOT"
	rm -rf "$SANDBOX/kit2"
	mkdir -p "$SANDBOX/kit2/bin"
	cp -R "$REAL_REPO/bin/." "$SANDBOX/kit2/bin/"
	NEWLINE_DIR="$(printf 'beta\nvictim')"
	mkdir -p "$SANDBOX/kit2/skills/alpha" "$SANDBOX/kit2/skills/$NEWLINE_DIR"
	printf '# alpha\n' > "$SANDBOX/kit2/skills/alpha/SKILL.md"
	printf '# split\n' > "$SANDBOX/kit2/skills/$NEWLINE_DIR/SKILL.md"
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit2" "$SANDBOX/kit2/bin/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "install skips the unrepresentable name"
	case "$OUT" in
	*"control character"*) : ;;
	*) fail "a newline in an entity name should be reported, got: $OUT" ;;
	esac
	assert_eq "$(awk -F '\t' '$1 == "victim"' "$STATE" | grep -c .)" 0 "no forged victim row"
	ln -sfn "$SANDBOX/kit2/skills/alpha" "$PI_ROOT/victim"
run_uninstall
	assert_link "$PI_ROOT/victim" "$SANDBOX/kit2/skills/alpha" "forged-looking row is not owned"
pass

# ==============================================================================
# T42: AGENT_KIT_ROOT is taken verbatim, so a trailing slash is not a reason to
# refuse the checkout as a source

new_test "T42 trailing slash in AGENT_KIT_ROOT"
use_path_empty
make_kit "$SANDBOX/kit"
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit/" "$SANDBOX/kit/bin/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "install with a trailing slash in the root"
	assert_link "$PI_ROOT/skills/alpha" "$SANDBOX/kit/skills/alpha" "links created from the same checkout"
	assert_eq "$(state_entries)" 6 "state records every entity"
	STATE_BEFORE="$(cat "$STATE")"
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit/" "$SANDBOX/kit/bin/agent-kit" install 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "reinstall with a trailing slash"
	case "$OUT" in
	*"0 created, 0 relinked, 6 up to date"*) : ;;
	*) fail "trailing slash must not cause relinks, got: $OUT" ;;
	esac
	assert_eq "$(cat "$STATE")" "$STATE_BEFORE" "state unchanged"
if OUT="$(AGENT_KIT_ROOT="$SANDBOX/kit/" "$SANDBOX/kit/bin/agent-kit" uninstall 2>&1)"; then RC=0; else RC=$?; fi
	assert_eq "$RC" 0 "uninstall with a trailing slash"
	assert_no_file "$PI_ROOT/skills/alpha" "links removed"
pass

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
