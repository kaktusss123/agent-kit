#!/usr/bin/env bash
#
# Layout regression tests: the retired multi-harness architecture must not
# reappear. agent-kit is a Pi-first framework; the canonical tree is
# skills/, extensions/, bin/, tests/ (+ prompts/ and scripts/ only when a
# category actually has content).
#
# Exit code: 0 when all checks pass, 1 otherwise.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REPO="$SELF_DIR"

PASS=0
FAIL=0

check() { # <what> <command...> — passes when the command succeeds
	local name="$1"
	shift
	if "$@"; then
		PASS=$((PASS + 1))
		printf 'pass %s\n' "$name"
	else
		FAIL=$((FAIL + 1))
		printf 'FAIL %s\n' "$name"
	fi
}

# --- no retired tree levels -----------------------------------------------------

check "no shared/ tree level" test ! -e "$REPO/shared"
check "no runtimes/ tree level" test ! -e "$REPO/runtimes"
check "no runtimes marker files anywhere" \
	bash -c "! find '$REPO' -path '$REPO/.git' -prune -o -path '$REPO/node_modules' -prune -o -name runtimes -print | grep -q ."
check "no bindings/ level" test ! -e "$REPO/bindings"
check "no skill-adapters/ level" test ! -e "$REPO/skill-adapters"
check "no vendor/ level" test ! -e "$REPO/vendor"
check "no runtime-bindings/ level" test ! -e "$REPO/runtime-bindings"
check "no vendor metadata dirs under skills/" \
	bash -c "! find '$REPO/skills' -type d \( -name agents -o -name bindings \) | grep -q ."

# --- skills are canonical packages ---------------------------------------------

check "every entry under skills/ is a directory" \
	bash -c "! find '$REPO/skills' -mindepth 1 -maxdepth 1 ! -type d | grep -q ."

# --- installer is Pi-only ---------------------------------------------------------

# The legacy state migration legitimately names retired runtimes; that
# knowledge must stay confined to the legacy_* functions. Strip them and
# require the remainder to be free of any retired-runtime or old-tree
# references.
REST="$(mktemp)"
awk '
	/^legacy_roots\(\) \{/ || /^legacy_retire\(\) \{/ || /^migrate_legacy_state\(\) \{/ { skip = 1; next }
	skip { if (/^}/) skip = 0; next }
	{ print }
' "$REPO/bin/agent-kit" > "$REST"
check "installer keeps the legacy state migration" \
	bash -c "grep -q '^migrate_legacy_state() {' '$REPO/bin/agent-kit'"
check "installer has retired-runtime knowledge only inside legacy_* functions" \
	bash -c "! grep -iqE '\bomp\b|opencode|runtimes/' '$REST'"
check "installer declares a single Pi root" \
	bash -c "grep -q 'PI_AGENT_DIR:.*/.pi/agent' '$REPO/bin/agent-kit'"
check "installer accepts no runtime arguments" \
	bash -c "grep -q 'manages a single runtime' '$REPO/bin/agent-kit'"
rm -f "$REST"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
