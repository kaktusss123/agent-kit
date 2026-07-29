#!/usr/bin/env bash
# Shared hook logic: re-link the OpenCode bundle into ~/.config/opencode/
# when the bundle repo already has an installed snapshot.
#
# Called by both post-merge and post-fetch. Idempotent — safe to invoke
# on every fetch even when nothing changed.

set -u

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${OPENCODE_TARGET_DIR:-$HOME/.config/opencode}"
STATE_FILE="$TARGET_DIR/.opencode-handoff-state.json"

# No state file → bundle was never installed here. Skip silently so
# fresh clones and unrelated repos don't get noisy output.
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Only act if at least one managed symlink points inside this bundle.
# Other bundles installed elsewhere keep their own post-fetch quiet.
if ! python3 -c '
import json, os, sys
try:
    state = json.load(open(sys.argv[1]))
    bundle = os.path.realpath(sys.argv[2])
    targets = state.get("managed_symlinks", {}).values()
    installed = any(
        os.path.commonpath([os.path.realpath(target), bundle]) == bundle
        for target in targets
    )
except (OSError, ValueError, json.JSONDecodeError):
    installed = False
sys.exit(0 if installed else 1)
' "$STATE_FILE" "$BUNDLE_DIR"; then
  exit 0
fi

echo "OpenCode hook: refreshing managed symlinks in $TARGET_DIR"
if ! "$BUNDLE_DIR/scripts/install.sh"; then
  echo "Warning: OpenCode links were not refreshed. Run scripts/install.sh manually." >&2
fi

exit 0
