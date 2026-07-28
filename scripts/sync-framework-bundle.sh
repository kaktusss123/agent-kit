#!/usr/bin/env bash
# Mirrors the approved framework bundle into the personal repository.

set -euo pipefail

PERSONAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_FRAMEWORK_DIR="$HOME/projects/core/docs/OpenCode"
FRAMEWORK_DIR="${1:-${OPENCODE_FRAMEWORK_DIR:-$DEFAULT_FRAMEWORK_DIR}}"
VENDOR_DIR="$PERSONAL_DIR/vendor/opencode-bundle"

if [ ! -d "$FRAMEWORK_DIR/agents" ] || [ ! -d "$FRAMEWORK_DIR/skills" ]; then
  echo "Error: framework bundle not found: $FRAMEWORK_DIR" >&2
  exit 1
fi

if ! git -C "$PERSONAL_DIR" diff --quiet -- "$VENDOR_DIR" || \
   ! git -C "$PERSONAL_DIR" diff --cached --quiet -- "$VENDOR_DIR"; then
  echo "Error: vendor snapshot has uncommitted changes. Commit or discard them first." >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"
rsync -a --delete --exclude .git --exclude node_modules \
  "$FRAMEWORK_DIR/" "$VENDOR_DIR/"

revision="$(git -C "$FRAMEWORK_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"
synced_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'source=%s\ncommit=%s\nsynced_at=%s\n' \
  "$FRAMEWORK_DIR" "$revision" "$synced_at" > "$VENDOR_DIR/.bundle-revision"

echo "Synced framework bundle to: $VENDOR_DIR"
echo "Source revision: $revision"
