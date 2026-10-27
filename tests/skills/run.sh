#!/usr/bin/env bash
#
# Skill package validation: light deterministic checks over skills/.
#
# - every skill is a directory with a SKILL.md;
# - frontmatter carries a name matching the directory and a description;
# - every referenced file (references/<name>.md) exists, including references
#   from nested files (references/<binding>/*.md and any other *.md under the
#   skill directory);
# - every skill:// cross-reference targets an existing skill, again across all
#   *.md under the skill directory plus Claude agents/commands and prompts;
# - skills/<name>/references/... paths cited from Claude agents/commands
#   resolve to tracked files;
# - no stale vendor language from the retired multi-harness layout.
#
# Exit code: 0 when all checks pass, 1 otherwise.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SKILLS="$SELF_DIR/skills"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf 'pass %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }

frontmatter_field() { # <skill-dir> <field> — value from the SKILL.md frontmatter
	awk 'NR == 1 && $0 != "---" { exit 1 } NR > 1 { if ($0 == "---") exit; print }' "$1/SKILL.md" \
		| sed -n "s/^$2:[[:space:]]*//p" | head -1
}

skill_markdown() { # <skill-dir> — every .md under the skill, including nested bindings
	find "$1" -name '*.md' -type f | sort
}

validate_skill() { # <skill-dir> <skills-root>
	skill_dir="$1"
	root="$2"
	skill="$(basename "$skill_dir")"

	if [ -f "$skill_dir/SKILL.md" ]; then
		ok "$skill: SKILL.md present"
	else
		bad "$skill: SKILL.md missing"
		return
	fi

	name="$(frontmatter_field "$skill_dir" name)"
	if [ "$name" = "$skill" ]; then
		ok "$skill: frontmatter name matches directory"
	else
		bad "$skill: frontmatter name '$name' does not match directory"
	fi

	if [ -n "$(frontmatter_field "$skill_dir" description)" ]; then
		ok "$skill: description present"
	else
		bad "$skill: description missing"
	fi

	# Referenced files must exist, in two forms:
	#   skills/<name>/references/<file>.md  → resolved from the skills root
	#   references/<file>.md                → resolved from this skill's dir
	# Scanned across every .md under the skill directory so nested bindings
	# (e.g. references/claude-code/*.md) cannot cite dangling files.
	stale_refs=0
	while IFS= read -r md; do
		while IFS= read -r target; do
			[ -n "$target" ] || continue
			if [ ! -f "$root/$target" ]; then
				bad "$skill: referenced file missing: $target (from ${md#"$skill_dir"/})"
				stale_refs=1
			fi
		done < <(grep -ohE 'skills/[A-Za-z0-9-]+/references/[A-Za-z0-9._/-]+\.md' "$md" | sed 's|^skills/||')
		while IFS= read -r ref; do
			[ -n "$ref" ] || continue
			if [ ! -f "$skill_dir/$ref" ]; then
				bad "$skill: referenced file missing: $ref (from ${md#"$skill_dir"/})"
				stale_refs=1
			fi
		done < <(sed 's|skills/[A-Za-z0-9-]*/references/|MASKED/|g' "$md" | grep -ohE 'references/[A-Za-z0-9._/-]+\.md')
	done < <(skill_markdown "$skill_dir")
	[ "$stale_refs" -eq 0 ] && ok "$skill: all referenced files exist"

	# skill:// cross-references must target existing skills (all .md scanned).
	# One file at a time: filenames with spaces must not be split (xargs once
	# divided them, silently hiding links and reporting false success).
	stale_links=0
	while IFS= read -r md; do
		while IFS= read -r target; do
			[ -n "$target" ] || continue
			if [ ! -d "$root/$target" ]; then
				bad "$skill: skill://$target does not exist"
				stale_links=1
			fi
		done < <(grep -ohE 'skill://[A-Za-z0-9-]+' "$md" 2>/dev/null | sed 's|^skill://||' || true)
	done < <(skill_markdown "$skill_dir")
	[ "$stale_links" -eq 0 ] && ok "$skill: all skill:// targets exist"
}

for skill_dir in "$SKILLS"/*/; do
	[ -d "$skill_dir" ] || continue
	validate_skill "$skill_dir" "$SKILLS"
done

# --- no stale vendor language from the retired multi-harness layout --------------

if grep -riqE '\bomp\b|opencode|oh-my-pi|omp-footer|task runtime' "$SKILLS"; then
	bad "stale vendor language found:"
	grep -rinE '\bomp\b|opencode|oh-my-pi|omp-footer|task runtime' "$SKILLS" | sed 's/^/    /'
else
	ok "no stale vendor language"
fi

# --- prompt templates are thin entrypoints into existing skills ----------------

# Pi prompts and their Claude Code command counterparts follow one contract.
for prompt in "$SELF_DIR"/prompts/*.md "$SELF_DIR"/claude-code/commands/*.md; do
	[ -f "$prompt" ] || continue
	name="${prompt#"$SELF_DIR"/}"

	if [ -n "$(awk 'NR == 1 && $0 != "---" { exit 1 } NR > 1 { if ($0 == "---") exit; print }' "$prompt" | sed -n 's/^description:[[:space:]]*//p')" ]; then
		ok "$name: description present"
	else
		bad "$name: description missing"
	fi

	lines="$(grep -c . "$prompt" || true)"
	if [ "$lines" -le 30 ]; then
		ok "$name: thin entrypoint ($lines non-empty lines)"
	else
		bad "$name: too long for an entrypoint ($lines non-empty lines)"
	fi

	missing=0
	while IFS= read -r target; do
		[ -n "$target" ] || continue
		if [ ! -d "$SKILLS/$target" ]; then
			bad "$name: skill://$target does not exist"
			missing=1
		fi
	done < <(grep -ohE 'skill://[A-Za-z0-9-]+' "$prompt" | sed 's|^skill://||')
	# Workflow entrypoints must bind canonical skills; a prompt may declare
	# itself standalone in the frontmatter (pure text transformation, no
	# skill policy). Standalone prompts keep target validation but are not
	# required to reference anything.
	standalone="$(awk 'NR == 1 && $0 != "---" { exit 1 } NR > 1 { if ($0 == "---") exit; print }' "$prompt" | sed -n '/^standalone:[[:space:]]*true[[:space:]]*$/p')"
	if [ -n "$standalone" ]; then
		ok "$name: standalone (no skill binding required)"
	elif [ "$missing" -eq 0 ] && grep -q 'skill://' "$prompt"; then
		ok "$name: all skill:// targets exist"
	elif [ "$missing" -eq 0 ]; then
		bad "$name: references no canonical skill"
	fi
done

# --- Claude agents: skill links and skill file paths must resolve ---------------

# Agent definitions live outside skills/ but cite the same contracts.
for agent in "$SELF_DIR"/claude-code/agents/*.md; do
	[ -f "$agent" ] || continue
	name="${agent#"$SELF_DIR"/}"
	agent_bad=0
	while IFS= read -r target; do
		[ -n "$target" ] || continue
		if [ ! -d "$SKILLS/$target" ]; then
			bad "$name: skill://$target does not exist"
			agent_bad=1
		fi
	done < <(grep -ohE 'skill://[A-Za-z0-9-]+' "$agent" | sed 's|^skill://||' || true)
	while IFS= read -r target; do
		[ -n "$target" ] || continue
		if [ ! -f "$SKILLS/$target" ]; then
			bad "$name: referenced file missing: skills/$target"
			agent_bad=1
		fi
	done < <(grep -ohE 'skills/[A-Za-z0-9-]+/references/[A-Za-z0-9._/-]+\.md' "$agent" | sed 's|^skills/||' || true)
	[ "$agent_bad" -eq 0 ] && ok "$name: skill links resolve"
done

# --- git-task: single-repo dev is RepoOwner-owned (no Main-owns-edits model) ----

if grep -q 'dispatch exactly one RepoOwner' "$SKILLS/git-task/SKILL.md" && \
	! grep -qE 'implements directly|/move' "$SKILLS/git-task/SKILL.md"; then
	ok "git-task: single-repo dev dispatches a RepoOwner"
else
	bad "git-task: single-repo dev must dispatch exactly one RepoOwner (no direct implementation, no /move)"
fi

# --- /dev independent review: explicit decision point, never a mandatory reviewer --

if grep -q 'role=review' "$SELF_DIR/prompts/dev.md" && \
	grep -q 'independent fresh-context reviewer' "$SELF_DIR/prompts/dev.md"; then
	ok "dev prompt: independent-review decision point surfaced"
else
	bad "dev prompt: must surface the explicit own-review vs independent-reviewer decision (plain spawn, role=review)"
fi

if grep -q 'explicit review decision' "$SKILLS/git-task/SKILL.md" && \
	grep -q 'role=review' "$SKILLS/git-task/SKILL.md" && \
	grep -q 'plain `subagent` spawn' "$SKILLS/git-task/SKILL.md" && \
	grep -q 'skill://code-review' "$SKILLS/git-task/SKILL.md" && \
	grep -q 'never the default reached by silence' "$SKILLS/git-task/SKILL.md" && \
	! grep -qiE 'must (always )?spawn (a |an )?(independent )?reviewer|reviewer (is |becomes )mandatory|independent review (is )?required for every' "$SKILLS/git-task/SKILL.md"; then
	ok "git-task: independent review policy states the decision and review-role plain-spawn mechanics without mandating it"
else
	bad "git-task: must state the explicit review decision + role=review plain-spawn mechanics, without an always-reviewer mandate"
fi

# --- regression probe: the validator must catch nested dangling references -----

# Committed fixtures prove the extended scan is real: bad-nested must fail on
# its nested binding file and skill link, ok-skill must pass clean.
FIXTURE_ROOT="$SELF_DIR/tests/skills/fixtures/nested-refs/skills"
probe_bad="$(PASS=0; FAIL=0; validate_skill "$FIXTURE_ROOT/bad-nested" "$FIXTURE_ROOT"; true)"
if grep -q 'referenced file missing: bad-nested/references/gone.md' <<<"$probe_bad" && \
	grep -q 'referenced file missing: references/missing.md' <<<"$probe_bad" && \
	grep -q 'skill://no-such-skill does not exist' <<<"$probe_bad"; then
	ok "validator probe: nested dangling references are caught"
else
	bad "validator probe: nested dangling references were NOT caught"
	printf '%s\n' "$probe_bad" | sed 's/^/    /'
fi
probe_ok="$(PASS=0; FAIL=0; validate_skill "$FIXTURE_ROOT/ok-skill" "$FIXTURE_ROOT"; true)"
if grep -q '^FAIL' <<<"$probe_ok"; then
	bad "validator probe: valid nested skill was flagged"
	printf '%s\n' "$probe_ok" | sed 's/^/    /'
else
	ok "validator probe: valid nested skill passes"
fi

# --- regression probe: whitespace in paths must not hide dangling links -----

# Filenames were once piped through xargs, which split on whitespace: a skill://
# link inside a file with spaces in its name was silently missed (grep failed,
# stderr was suppressed) and the validator reported false success.
SPACE_T="$(mktemp -d "${TMPDIR:-/tmp}/space probe.XXXXXX")"
mkdir -p "$SPACE_T/skills"
cp -R "$FIXTURE_ROOT/ok-skill" "$SPACE_T/skills/ok-skill"
mkdir -p "$SPACE_T/skills/bad-space"
printf -- '---\nname: bad-space\ndescription: d\n---\n' > "$SPACE_T/skills/bad-space/SKILL.md"
printf 'see skill://no-such-space-test\n' > "$SPACE_T/skills/bad-space/note with space.md"
probe_space_ok="$(PASS=0; FAIL=0; validate_skill "$SPACE_T/skills/ok-skill" "$SPACE_T/skills"; true)"
if grep -q '^FAIL' <<<"$probe_space_ok"; then
	bad "whitespace probe: valid skill under a spaced path was flagged"
	printf '%s\n' "$probe_space_ok" | sed 's/^/    /'
else
	ok "whitespace probe: valid skill under a spaced path passes"
fi
probe_space_bad="$(PASS=0; FAIL=0; validate_skill "$SPACE_T/skills/bad-space" "$SPACE_T/skills"; true)"
if grep -q 'skill://no-such-space-test does not exist' <<<"$probe_space_bad"; then
	ok "whitespace probe: dangling link in a spaced path is caught"
else
	bad "whitespace probe: dangling link in a spaced path was NOT caught"
	printf '%s\n' "$probe_space_bad" | sed 's/^/    /'
fi
rm -rf "$SPACE_T"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
