#!/usr/bin/env bash
#
# Skill package validation: light deterministic checks over skills/.
#
# - every skill is a directory with a SKILL.md;
# - frontmatter carries a name matching the directory and a description;
# - every referenced file (references/<name>.md) exists;
# - every skill:// cross-reference targets an existing skill;
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

for skill_dir in "$SKILLS"/*/; do
	[ -d "$skill_dir" ] || continue
	skill="$(basename "$skill_dir")"

	if [ -f "$skill_dir/SKILL.md" ]; then
		ok "$skill: SKILL.md present"
	else
		bad "$skill: SKILL.md missing"
		continue
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
	stale_refs=0
	for md in "$skill_dir/SKILL.md" "$skill_dir"/references/*.md; do
		[ -f "$md" ] || continue
		while IFS= read -r target; do
			[ -n "$target" ] || continue
			if [ ! -f "$SKILLS/$target" ]; then
				bad "$skill: referenced file missing: $target"
				stale_refs=1
			fi
		done < <(grep -ohE 'skills/[A-Za-z0-9-]+/references/[A-Za-z0-9._/-]+\.md' "$md" | sed 's|^skills/||')
		while IFS= read -r ref; do
			[ -n "$ref" ] || continue
			if [ ! -f "$skill_dir/$ref" ]; then
				bad "$skill: referenced file missing: $ref"
				stale_refs=1
			fi
		done < <(sed 's|skills/[A-Za-z0-9-]*/references/|MASKED/|g' "$md" | grep -ohE 'references/[A-Za-z0-9._/-]+\.md')
	done
	[ "$stale_refs" -eq 0 ] && ok "$skill: all referenced files exist"

	# skill:// cross-references must target existing skills.
	stale_links=0
	while IFS= read -r target; do
		[ -n "$target" ] || continue
		if [ ! -d "$SKILLS/$target" ]; then
			bad "$skill: skill://$target does not exist"
			stale_links=1
		fi
	done < <(grep -ohE 'skill://[A-Za-z0-9-]+' "$skill_dir/SKILL.md" "$skill_dir"/references/*.md 2>/dev/null | sed 's|^skill://||' || true)
	[ "$stale_links" -eq 0 ] && ok "$skill: all skill:// targets exist"
done

# --- no stale vendor language from the retired multi-harness layout --------------

if grep -riqE '\bomp\b|opencode|oh-my-pi|omp-footer|task runtime' "$SKILLS"; then
	bad "stale vendor language found:"
	grep -rinE '\bomp\b|opencode|oh-my-pi|omp-footer|task runtime' "$SKILLS" | sed 's/^/    /'
else
	ok "no stale vendor language"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
