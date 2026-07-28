#!/usr/bin/env bash
# Enables versioned hooks and refreshes the active runtime once.

set -euo pipefail

PERSONAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRAMEWORK_DIR="${OPENCODE_FRAMEWORK_DIR:-$HOME/projects/core/docs/OpenCode}"

git -C "$PERSONAL_DIR" config core.hooksPath .githooks

if [ -x "$FRAMEWORK_DIR/scripts/install.sh" ]; then
  "$FRAMEWORK_DIR/scripts/install.sh"
else
  "$PERSONAL_DIR/scripts/install-vendored-bundle.sh"
fi

echo "Enabled hooks for: $PERSONAL_DIR"
