#!/usr/bin/env bash
#
# Layout regression tests: the retired multi-harness architecture (shared/,
# runtimes/, bindings, runtime markers) must not reappear. One canonical tree
# — skills/, extensions/, bin/, tests/, rules/ (+ prompts/ and scripts/ only
# when a category actually has content) — is linked into every selected host
# by the installer (ADR-0007, ADR-0009).
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

# --- installer hosts ---------------------------------------------------------

# The legacy state migration legitimately names retired runtimes; that
# knowledge lives in exactly one module, and the rest of the executable must
# stay free of any retired-runtime or old-tree reference.
check "installer keeps the legacy state migration" \
	grep -q 'export function migrateLegacyState' "$REPO/bin/lib/legacy-state.mjs"
check "legacy state module still names the retired runtimes it cleans up" \
	bash -c "grep -qiE '\\bomp\\b|opencode' '$REPO/bin/lib/legacy-state.mjs'"
check "installer names retired runtimes only in the legacy state module" \
	bash -c "! grep -rliE '\\bomp\\b|opencode|runtimes/' '$REPO/bin' --exclude=legacy-state.mjs | grep -q ."
check "installer declares a single Pi root" \
	bash -c "grep -q 'PI_AGENT_DIR' '$REPO/bin/lib/paths.mjs' && grep -q 'join(home, \".pi\", \"agent\")' '$REPO/bin/lib/paths.mjs'"
check "installer host arguments are limited to the known hosts (ADR-0009)" \
	bash -c "grep -q '^export const HOSTS = \[\"pi\", \"claude-code\"\];$' '$REPO/bin/lib/paths.mjs' && awk '/case \"install\":/,/case \"uninstall\":/' '$REPO/bin/agent-kit' | grep -q 'validateHosts(rest)'"
check "installer declares the claude-code root" \
	bash -c "grep -q 'CLAUDE_CONFIG_DIR' '$REPO/bin/lib/paths.mjs' && grep -q 'join(home, \".claude\")' '$REPO/bin/lib/paths.mjs'"

# --- task root carries no retired-run location legacy ----------------------------

check "task-root default is ~/.agent-kit/tasks" \
	bash -c "grep -q '\"\.agent-kit\", \"tasks\"' '$REPO/extensions/task-workspace/task-root.ts'"
check "task-root resolver has no OMP_TASK_ROOT or .omp path" \
	bash -c "! grep -qE 'OMP_TASK_ROOT|\.omp' '$REPO/extensions/task-workspace/task-root.ts'"
check "active tree has no retired task-root/harness terminology" \
	bash -c "! grep -rniqE 'OMP_TASK_ROOT|\.omp/tasks|OMP_AGENT_DIR|OPENCODE_CONFIG_DIR|harness-agnostic|every harness' \
		'$REPO/extensions' '$REPO/skills' '$REPO/prompts' '$REPO/tests' '$REPO/README.md' \
		--exclude=run.sh --exclude=task-root.test.ts"
# Exclusions: run.sh files carry these check patterns themselves, and
# task-root.test.ts is the deliberate negative pin proving the retired
# alias is ignored (behavioral proof, not live support).
check "no /move in active workflow surface" \
	bash -c "! grep -rnqE '(^|[\`[:space:]])/move\b' '$REPO/skills' '$REPO/prompts'"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
