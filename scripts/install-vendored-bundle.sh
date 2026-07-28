#!/usr/bin/env bash
# Installs the vendored framework snapshot into this personal runtime.

set -euo pipefail

PERSONAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$PERSONAL_DIR/vendor/opencode-bundle/scripts/install.sh"

if [ ! -x "$INSTALLER" ]; then
  echo "Error: vendored bundle installer not found: $INSTALLER" >&2
  echo "Run scripts/sync-framework-bundle.sh on a machine with framework access." >&2
  exit 1
fi

exec "$INSTALLER" --target-dir "$PERSONAL_DIR" "$@"
