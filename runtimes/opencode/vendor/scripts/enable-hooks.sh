#!/usr/bin/env bash
# Enables versioned hooks and installs the framework bundle once.

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! git -C "$BUNDLE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: bundle directory is not a Git worktree: $BUNDLE_DIR" >&2
  exit 1
fi

# Hooks live in the monorepo root .githooks/; git resolves a relative
# core.hooksPath against the worktree root.
REPO_ROOT="$(cd "$(git -C "$BUNDLE_DIR" rev-parse --show-toplevel)" && pwd)"

if [ ! -d "$REPO_ROOT/.githooks" ]; then
  echo "Error: hooks directory not found at repo root: $REPO_ROOT/.githooks" >&2
  exit 1
fi

git -C "$REPO_ROOT" config core.hooksPath .githooks
"$BUNDLE_DIR/scripts/install.sh"

echo "Enabled hooks for: $REPO_ROOT"
