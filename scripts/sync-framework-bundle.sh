#!/usr/bin/env bash
# Mirrors the approved framework bundle into the personal repository.

set -euo pipefail

PERSONAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_FRAMEWORK_DIR="$HOME/projects/core/docs/OpenCode"
FORCE=false

if [ "${1:-}" = "--force" ]; then
  FORCE=true
  shift
fi

FRAMEWORK_DIR="${1:-${OPENCODE_FRAMEWORK_DIR:-$DEFAULT_FRAMEWORK_DIR}}"
VENDOR_DIR="$PERSONAL_DIR/vendor/opencode-bundle"

if [ ! -d "$FRAMEWORK_DIR/agents" ] || [ ! -d "$FRAMEWORK_DIR/skills" ]; then
  echo "Error: framework bundle not found: $FRAMEWORK_DIR" >&2
  exit 1
fi

if ! git -C "$FRAMEWORK_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: framework bundle is not in a Git worktree: $FRAMEWORK_DIR" >&2
  exit 1
fi

if [ "$FORCE" = false ] && \
   { ! git -C "$PERSONAL_DIR" diff --quiet -- "$VENDOR_DIR" || \
     ! git -C "$PERSONAL_DIR" diff --cached --quiet -- "$VENDOR_DIR"; }; then
  echo "Error: vendor snapshot has uncommitted changes. Commit or discard them first." >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

repository_dir="$(git -C "$FRAMEWORK_DIR" rev-parse --show-toplevel)"
bundle_prefix="$(git -C "$FRAMEWORK_DIR" rev-parse --show-prefix)"
revision="$(git -C "$FRAMEWORK_DIR" rev-parse HEAD)"

git -C "$repository_dir" archive --format=tar HEAD "$bundle_prefix" | \
  tar -x -C "$temporary_dir" --strip-components=1
rsync -a --delete "$temporary_dir/" "$VENDOR_DIR/"
synced_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'source=%s\ncommit=%s\nsynced_at=%s\n' \
  "$FRAMEWORK_DIR" "$revision" "$synced_at" > "$VENDOR_DIR/.bundle-revision"

echo "Synced framework bundle to: $VENDOR_DIR"
echo "Source revision: $revision"
