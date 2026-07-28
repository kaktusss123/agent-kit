#!/usr/bin/env bash
# Enables versioned hooks and installs the framework bundle once.

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! git -C "$BUNDLE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: bundle directory is not a Git worktree: $BUNDLE_DIR" >&2
  exit 1
fi

git -C "$BUNDLE_DIR" config core.hooksPath .githooks
"$BUNDLE_DIR/scripts/install.sh"

echo "Enabled hooks for: $BUNDLE_DIR"
