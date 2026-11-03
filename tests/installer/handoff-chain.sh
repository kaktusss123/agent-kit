#!/usr/bin/env bash
# Optional cross-product integration. Uses committed trees and local-only Git
# remotes in a disposable HOME; never updates or installs into the input repos.
# Supply the independently verified corporate checkout explicitly. No corporate
# resource contents are embedded in this public test.
set -euo pipefail

CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BASE=fb5439698b1483d5dbb43bd31fea898630ddc54b
CANDIDATE="$(git -C "$CORE" rev-parse HEAD)"
CORP="${AGENT_KIT_CLOUDRU_REPO:?Set AGENT_KIT_CLOUDRU_REPO to the verified corporate checkout}"
CORP="$(cd "$CORP" && pwd -P)"
CORP_CANDIDATE="$(git -C "$CORP" rev-parse HEAD)"
REL=skills/kuber-nagibator
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ak-handoff.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
unset AGENT_KIT_ROOT AGENT_KIT_CLOUDRU_ROOT PI_CODING_AGENT_DIR
export HOME="$TMP/setup-home" XDG_STATE_HOME="$TMP/setup-home/.local/state"
export PI_AGENT_DIR="$HOME/.pi/agent" CLAUDE_CONFIG_DIR="$HOME/.claude"
mkdir -p "$HOME" "$TMP/seed" "$TMP/corporate"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
check_link() { [ "$(readlink "$1")" = "$2" ] || fail "unexpected symlink target"; }
no_path() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "retired path still present"; }
no_row() { ! awk -F '\t' -v rel="$REL" '$1 == rel { found=1 } END { exit !found }' "$1" || fail "Core retained corporate ownership"; }
commit_fixture() {
	git -C "$1" -c user.name=fixture -c user.email=fixture@example.invalid add -A
	git -C "$1" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "$2"
}
machine() {
	export HOME="$TMP/home-$1" XDG_STATE_HOME="$TMP/home-$1/.local/state"
	export PI_AGENT_DIR="$HOME/.pi/agent" CLAUDE_CONFIG_DIR="$HOME/.claude"
	mkdir -p "$PI_AGENT_DIR" "$CLAUDE_CONFIG_DIR"
}
core() { local repo="$1"; shift; (cd "$repo" && node bin/agent-kit "$@") > "$TMP/core.log" 2>&1 || { tail -20 "$TMP/core.log" >&2; fail 'Core command failed'; }; }
corporate() { node "$TMP/corporate/bin/agent-kit-cloudru" "$@" > "$TMP/corporate.log" 2>&1 || fail 'corporate command failed'; }

# Inventory verification reads the supplied repositories, not installed state.
node "$CORP/tests/inventory/run.mjs" --source "$CORE"
[ -z "$(git -C "$CORE" ls-tree -r --name-only "$CANDIDATE" -- "$REL" extensions/inspection-channel extensions/inspection-provider)" ] || fail 'candidate still delivers retired resources'
git -C "$CORP" archive "$CORP_CANDIDATE" | tar -x -C "$TMP/corporate"
corporate verify

git -C "$CORE" archive "$BASE" | tar -x -C "$TMP/seed"
git -C "$TMP/seed" init -q -b main
commit_fixture "$TMP/seed" "old Core $BASE"
git clone -q --bare "$TMP/seed" "$TMP/origin.git"
for scenario in negative migrated; do
	git clone -q "$TMP/origin.git" "$TMP/$scenario"
	machine "$scenario"
	core "$TMP/$scenario" install --profile full pi claude-code
	check_link "$PI_AGENT_DIR/$REL" "$TMP/$scenario/$REL"
	check_link "$CLAUDE_CONFIG_DIR/$REL" "$TMP/$scenario/$REL"
done

# Handoff MUST happen while the original checkout and targets still exist.
machine migrated
corporate migrate
corporate migrate
check_link "$PI_AGENT_DIR/$REL" "$TMP/corporate/$REL"
check_link "$CLAUDE_CONFIG_DIR/$REL" "$TMP/corporate/$REL"
no_row "$XDG_STATE_HOME/agent-kit/links.tsv"
no_row "$XDG_STATE_HOME/agent-kit/links-claude-code.tsv"
printf 'PASS: actual baseline full install and repeatable pre-pull handoff\n'

# Publish the actual Core candidate bytes to the fixture's LOCAL origin, not
# a synthetic deletion-only tree. Both old updaters pull this exact tree.
git clone -q "$TMP/origin.git" "$TMP/next"
git -C "$TMP/next" rm -rq .
git -C "$CORE" archive "$CANDIDATE" | tar -x -C "$TMP/next"
commit_fixture "$TMP/next" "new Core $CANDIDATE"
[ "$(git -C "$TMP/next" rev-parse 'HEAD^{tree}')" = "$(git -C "$CORE" rev-parse "$CANDIDATE^{tree}")" ] || fail 'fixture tree differs from candidate'
git -C "$TMP/next" push -q origin main

machine negative
core "$TMP/negative" update
no_path "$PI_AGENT_DIR/$REL"
no_path "$CLAUDE_CONFIG_DIR/$REL"
printf 'PASS: negative control reproduces unmigrated old updater link loss\n'

machine migrated
core "$TMP/migrated" update
[ "$(git -C "$TMP/migrated" rev-parse 'HEAD^{tree}')" = "$(git -C "$CORE" rev-parse "$CANDIDATE^{tree}")" ] || fail 'old updater did not pull candidate'
for root in "$PI_AGENT_DIR" "$CLAUDE_CONFIG_DIR"; do
	check_link "$root/$REL" "$TMP/corporate/$REL"
	[ -f "$root/$REL/SKILL.md" ] || fail 'handoff resource became unreadable'
done
no_path "$PI_AGENT_DIR/extensions/inspection-channel"
no_path "$PI_AGENT_DIR/extensions/inspection-provider"
no_row "$XDG_STATE_HOME/agent-kit/links.tsv"
no_row "$XDG_STATE_HOME/agent-kit/links-claude-code.tsv"
core "$TMP/migrated" install
core "$TMP/migrated" install
printf 'PASS: actual old updater pulls actual candidate; handoff links survive repeat reconcile\n'

core "$TMP/migrated" uninstall
check_link "$PI_AGENT_DIR/$REL" "$TMP/corporate/$REL"
check_link "$CLAUDE_CONFIG_DIR/$REL" "$TMP/corporate/$REL"
core "$TMP/migrated" install
corporate uninstall
no_path "$PI_AGENT_DIR/$REL"
no_path "$CLAUDE_CONFIG_DIR/$REL"
check_link "$PI_AGENT_DIR/skills/git-task" "$TMP/migrated/skills/git-task"
check_link "$CLAUDE_CONFIG_DIR/skills/git-task" "$TMP/migrated/skills/git-task"
printf 'PASS: independent uninstall in both directions preserves the other product\n'
printf 'PASS: baseline=%s Core=%s corporate=%s (isolated fixture; no live installation)\n' "$BASE" "$CANDIDATE" "$CORP_CANDIDATE"
