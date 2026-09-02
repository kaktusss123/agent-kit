#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${HOME}/.config/opencode"
EXAMPLE_CONFIG="$BUNDLE_DIR/opencode.example.jsonc"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      TARGET_DIR="${2:?--target-dir requires a path}"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--target-dir PATH]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

CONFIG_FILE=""
if [ -f "$TARGET_DIR/opencode.json" ]; then
  CONFIG_FILE="$TARGET_DIR/opencode.json"
elif [ -f "$TARGET_DIR/opencode.jsonc" ]; then
  CONFIG_FILE="$TARGET_DIR/opencode.jsonc"
fi

if [ -z "$CONFIG_FILE" ]; then
  mkdir -p "$TARGET_DIR"
  cp "$EXAMPLE_CONFIG" "$TARGET_DIR/opencode.jsonc"
  echo "Created $TARGET_DIR/opencode.jsonc from the framework example."
  exit 0
fi

python3 - "$CONFIG_FILE" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()

def strip_jsonc(value: str) -> str:
    out = []
    i = 0
    in_string = False
    line_comment = False
    block_comment = False
    while i < len(value):
        if line_comment:
            if value[i] == "\n":
                line_comment = False
                out.append(value[i])
            i += 1
            continue
        if block_comment:
            if value[i:i + 2] == "*/":
                block_comment = False
                i += 2
            else:
                i += 1
            continue
        if in_string:
            out.append(value[i])
            if value[i] == "\\" and i + 1 < len(value):
                out.append(value[i + 1])
                i += 2
                continue
            if value[i] == '"':
                in_string = False
            i += 1
            continue
        if value[i] == '"':
            in_string = True
            out.append(value[i])
            i += 1
            continue
        if value[i:i + 2] == "//":
            line_comment = True
            i += 2
            continue
        if value[i:i + 2] == "/*":
            block_comment = True
            i += 2
            continue
        out.append(value[i])
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))

data = json.loads(strip_jsonc(text))
errors = []

cloudru = data.get("provider", {}).get("cloudru", {})
if cloudru.get("options", {}).get("baseURL") != "https://foundation-models.api.cloud.ru/v1":
    errors.append("provider.cloudru.options.baseURL is missing or incorrect")
if cloudru.get("options", {}).get("apiKey") != "{env:CLOUDRU_API_KEY}":
    errors.append("provider.cloudru.options.apiKey must use {env:CLOUDRU_API_KEY}")

if data.get("default_agent") not in {"General", "dev-orchestrator"}:
    errors.append("default_agent must be General or dev-orchestrator")

agents = data.get("agent", {})
for builtin in ("explore", "build", "plan"):
    if agents.get(builtin, {}).get("disable") is not True:
        errors.append(f"agent.{builtin}.disable must be true")

required = {
    "General",
    "spec-analyst",
    "dev-orchestrator",
    "repo-scout",
    "designer",
    "implementer",
    "reviewer",
    "security-reviewer",
    "committer",
}
missing = sorted(required - agents.keys())
if missing:
    errors.append("missing core agent model assignments: " + ", ".join(missing))

if "kanban" in data.get("mcp", {}):
    print("WARNING: kanban MCP is configured but is not used by the core framework.")

if errors:
    for error in errors:
        print("ERROR:", error)
    raise SystemExit(1)

print("Config validation passed.")
PY
