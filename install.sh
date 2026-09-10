#!/usr/bin/env bash
# Install pi entities from this checkout into ~/.pi/agent/extensions.
#
# Usage:
#   ./install.sh                 # install everything under extensions/
#   ./install.sh todo perf-stats # install only the named entities
#
# Symlinks are (re)pointed at THIS checkout: run the script from the worktree
# you want pi to load. Without arguments the last run wins — when several
# worktrees are active, pass explicit names to relink only your entities.
# The previous target is never modified, so switching links never touches
# another worktree's files; a dangling symlink from a deleted worktree is
# replaced. Non-symlink files in the destination are never touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"
DEST="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"

if [ ! -d "$REPO_ROOT/extensions" ]; then
	echo "error: no extensions/ directory in $REPO_ROOT" >&2
	exit 1
fi

if [ $# -gt 0 ]; then
	entities=()
	for name in "$@"; do
		if [ ! -e "$REPO_ROOT/extensions/$name" ]; then
			echo "error: no entity '$name' in $REPO_ROOT/extensions" >&2
			exit 1
		fi
		entities+=("$REPO_ROOT/extensions/$name")
	done
else
	entities=("$REPO_ROOT"/extensions/*)
fi

mkdir -p "$DEST"
echo "installing from $REPO_ROOT"
echo "into $DEST"
echo

installed=0
skipped=0
for src in "${entities[@]}"; do
	name="$(basename "$src")"
	dst="$DEST/$name"

	# Protect user-owned files: only symlinks we manage are ever replaced.
	if [ -e "$dst" ] && [ ! -L "$dst" ]; then
		echo "skip $name: $dst exists and is not a symlink"
		skipped=$((skipped + 1))
		continue
	fi

	if [ -L "$dst" ]; then
		old="$(readlink "$dst")"
		if [ "$old" = "$src" ]; then
			echo "ok   $name (already linked)"
			continue
		fi
		if [ -e "$dst" ]; then
			echo "link $name"
			echo "       was: $old"
		else
			echo "link $name (replacing dangling symlink, was: $old)"
		fi
		ln -sfn "$src" "$dst"
	else
		echo "link $name -> $src"
		ln -s "$src" "$dst"
	fi
	installed=$((installed + 1))
done

echo
if [ "$installed" -eq 0 ] && [ "$skipped" -eq 0 ]; then
	echo "nothing to do: everything already links to this checkout"
fi
if [ "$skipped" -gt 0 ]; then
	echo "note: skipped entries exist as real files in the destination;"
	echo "      delete them there and rerun if you want them repo-managed"
fi
