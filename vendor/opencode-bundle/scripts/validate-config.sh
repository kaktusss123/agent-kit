#!/usr/bin/env bash
# validate-config.sh — Validates an opencode config against the handoff
# baseline, or creates one from the example if missing.
#
# Behavior (FR-015..FR-017):
#   - If target opencode.json(c) is missing: create from example
#   - If it exists: validate required settings, report errors/warnings/recommendations
#   - Never auto-patch an existing config

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${HOME}/.config/opencode"
EXAMPLE_CONFIG="$BUNDLE_DIR/opencode.example.jsonc"

usage() {
  echo "Usage: $0 [--target-dir PATH]"
  echo "  --target-dir PATH  Validate or create config in a custom directory"
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      if [ "$#" -lt 2 ]; then
        echo "Error: --target-dir requires a path"
        exit 1
      fi
      if [ -z "$2" ]; then
        echo "Error: --target-dir cannot be empty"
        exit 1
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done
# JSON parser: prefer jq (with --jsonargs for safety), fallback to python3
if command -v jq &>/dev/null; then
  JSON_TOOL="jq"
elif command -v python3 &>/dev/null; then
  JSON_TOOL="python3"
else
  echo "Error: neither jq nor python3 found; cannot parse JSON"
  exit 1
fi

# --- JSONC helpers ---

# Strip JSONc comments safely: removes // and /* */ but preserves // inside strings
# Uses python3 for reliable parsing regardless of JSON_TOOL choice
jsonc_to_json() {
  local file="$1"
  python3 -c "
import sys

def strip_jsonc(text):
    result = []
    i = 0
    in_string = False
    in_line_comment = False
    in_block_comment = False
    while i < len(text):
        if in_line_comment:
            if text[i] == '\n':
                in_line_comment = False
                result.append(text[i])
            i += 1
            continue
        if in_block_comment:
            if text[i] == '*' and i + 1 < len(text) and text[i+1] == '/':
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if in_string:
            result.append(text[i])
            if text[i] == '\\\\' and i + 1 < len(text):
                result.append(text[i+1])
                i += 2
                continue
            if text[i] == '\"':
                in_string = False
            i += 1
            continue
        if text[i] == '\"':
            in_string = True
            result.append(text[i])
            i += 1
            continue
        if text[i:i+2] == '//':
            in_line_comment = True
            i += 2
            continue
        if text[i:i+2] == '/*':
            in_block_comment = True
            i += 2
            continue
        result.append(text[i])
        i += 1
    return ''.join(result)

import re, sys
with open(sys.argv[1]) as f:
    content = f.read()
clean = re.sub(r',(\s*[}\]])', r'\1', strip_jsonc(content))
print(clean)
" "$file"
}

# --- JSON helpers ---

json_get() {
  local file="$1"
  local key="$2"
  if [ "$JSON_TOOL" = "jq" ]; then
    local json_content
    json_content="$(jsonc_to_json "$file")"
    echo "$json_content" | jq -r "$key // \"__null__\"" 2>/dev/null || echo "__null__"
  else
    python3 -c "
import json, sys, re

def strip_jsonc(text):
    result = []
    i = 0
    in_string = False
    in_line_comment = False
    in_block_comment = False
    while i < len(text):
        if in_line_comment:
            if text[i] == '\n':
                in_line_comment = False
                result.append(text[i])
            i += 1
            continue
        if in_block_comment:
            if text[i] == '*' and i + 1 < len(text) and text[i+1] == '/':
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if in_string:
            result.append(text[i])
            if text[i] == '\\\\' and i + 1 < len(text):
                result.append(text[i+1])
                i += 2
                continue
            if text[i] == '\"':
                in_string = False
            i += 1
            continue
        if text[i] == '\"':
            in_string = True
            result.append(text[i])
            i += 1
            continue
        if text[i:i+2] == '//':
            in_line_comment = True
            i += 2
            continue
        if text[i:i+2] == '/*':
            in_block_comment = True
            i += 2
            continue
        result.append(text[i])
        i += 1
    return ''.join(result)

with open(sys.argv[1]) as f:
    content = f.read()
clean = re.sub(r',(\s*[}\]])', r'\1', strip_jsonc(content))
data = json.loads(clean)
keys = sys.argv[2].lstrip('.').split('.')
obj = data
for k in keys:
    if isinstance(obj, dict) and k in obj:
        obj = obj[k]
    else:
        print('__null__')
        sys.exit(0)
print(json.dumps(obj) if not isinstance(obj, str) else obj)
" "$file" "$key" 2>/dev/null || echo "__null__"
  fi
}

json_has_key() {
  local file="$1"
  local key="$2"
  local val
  val="$(json_get "$file" "$key")"
  [ "$val" != "__null__" ]
}

# --- Create config from example if missing ---

create_config_from_example() {
  echo "No opencode.json or opencode.jsonc found in $TARGET_DIR."
  echo ""

  if [ ! -f "$EXAMPLE_CONFIG" ]; then
    echo "Error: example config not found at $EXAMPLE_CONFIG"
    exit 1
  fi

  echo "Creating config from bundle example: $EXAMPLE_CONFIG"
  mkdir -p "$TARGET_DIR"

  # Copy example verbatim — OpenCode natively supports JSONC
  cp "$EXAMPLE_CONFIG" "$TARGET_DIR/opencode.jsonc"

  echo "Created: $TARGET_DIR/opencode.jsonc"
  echo ""
  echo "Next steps:"
  echo "  1. Set CLOUDRU_API_KEY in your shell profile:"
  echo "     echo 'export CLOUDRU_API_KEY=your-key-here' >> ~/.zshrc  # or ~/.bashrc"
  echo "     source ~/.zshrc  # or source ~/.bashrc"
  echo "  2. Run 'opencode' in a project to start a session."
  exit 0
}

# --- Validate existing config ---

validate_config() {
  local config_file="$1"
  local errors=0
  local warnings=0
  local recommendations=0

  echo "Validating existing config: $config_file"
  echo ""

  # --- ERRORS (must-fix) ---

  echo "Errors:"

  # FR: provider.cloudru must exist
  if json_has_key "$config_file" '.provider.cloudru'; then
    echo "  [OK] provider.cloudru is present"
  else
    echo "  [ERROR] provider.cloudru is missing"
    ((errors++)) || true
  fi

  # FR: provider.cloudru.options.baseURL must match Cloud.ru endpoint
  local base_url
  base_url="$(json_get "$config_file" '.provider.cloudru.options.baseURL')"
  if [ "$base_url" = "https://foundation-models.api.cloud.ru/v1" ]; then
    echo "  [OK] provider.cloudru.options.baseURL is correct"
  elif [ "$base_url" = "__null__" ]; then
    echo "  [ERROR] provider.cloudru.options.baseURL is missing"
    ((errors++)) || true
  else
    echo "  [ERROR] provider.cloudru.options.baseURL is '$base_url', expected 'https://foundation-models.api.cloud.ru/v1'"
    ((errors++)) || true
  fi

  # FR: {env:CLOUDRU_API_KEY} usage in apiKey
  local api_key
  api_key="$(json_get "$config_file" '.provider.cloudru.options.apiKey')"
  if [ "$api_key" = "{env:CLOUDRU_API_KEY}" ]; then
    echo "  [OK] provider.cloudru.options.apiKey uses {env:CLOUDRU_API_KEY}"
    # Also check if the env var is actually set
    if [ -z "${CLOUDRU_API_KEY:-}" ]; then
      echo "  [WARNING] CLOUDRU_API_KEY is not set in the current environment"
      ((warnings++)) || true
    else
      echo "  [OK] CLOUDRU_API_KEY is set in the current environment"
    fi
  elif [ "$api_key" = "__null__" ]; then
    echo "  [ERROR] provider.cloudru.options.apiKey is missing (should use {env:CLOUDRU_API_KEY})"
    ((errors++)) || true
  else
    # Has some value but not the env var reference — could be a literal key
    echo "  [ERROR] provider.cloudru.options.apiKey is set to a literal value instead of {env:CLOUDRU_API_KEY}"
    ((errors++)) || true
  fi

  # FR: default_agent must be "dev-orchestrator"
  local default_agent
  default_agent="$(json_get "$config_file" '.default_agent')"
  if [ "$default_agent" = "dev-orchestrator" ]; then
    echo "  [OK] default_agent is 'dev-orchestrator'"
  elif [ "$default_agent" = "__null__" ]; then
    echo "  [ERROR] default_agent is missing (should be 'dev-orchestrator')"
    ((errors++)) || true
  else
    echo "  [ERROR] default_agent is '$default_agent', expected 'dev-orchestrator'"
    ((errors++)) || true
  fi

  # FR: explore must be disabled via agent.explore.disable
  local explore_disable
  explore_disable="$(json_get "$config_file" '.agent.explore.disable')"
  if [ "$explore_disable" = "true" ]; then
    echo "  [OK] agent.explore.disable is true"
  elif [ "$explore_disable" = "__null__" ]; then
    echo "  [ERROR] agent.explore.disable is missing (explore agent should be disabled)"
    ((errors++)) || true
  else
    echo "  [ERROR] agent.explore.disable is '$explore_disable', expected true"
    ((errors++)) || true
  fi

  # FR: build must be disabled via agent.build.disable
  local build_disable
  build_disable="$(json_get "$config_file" '.agent.build.disable')"
  if [ "$build_disable" = "true" ]; then
    echo "  [OK] agent.build.disable is true"
  elif [ "$build_disable" = "__null__" ]; then
    echo "  [ERROR] agent.build.disable is missing (build agent should be disabled)"
    ((errors++)) || true
  else
    echo "  [ERROR] agent.build.disable is '$build_disable', expected true"
    ((errors++)) || true
  fi

  # FR: plan must be disabled via agent.plan.disable
  local plan_disable
  plan_disable="$(json_get "$config_file" '.agent.plan.disable')"
  if [ "$plan_disable" = "true" ]; then
    echo "  [OK] agent.plan.disable is true"
  elif [ "$plan_disable" = "__null__" ]; then
    echo "  [ERROR] agent.plan.disable is missing (plan agent should be disabled)"
    ((errors++)) || true
  else
    echo "  [ERROR] agent.plan.disable is '$plan_disable', expected true"
    ((errors++)) || true
  fi

  echo ""

  # --- WARNINGS (should-fix) ---

  echo "Warnings:"

  # Check agent model assignments
  if json_has_key "$config_file" '.agent'; then
    echo "  [OK] agent model assignments are present"
  else
    echo "  [WARNING] agent section is missing — agents will use default model"
    ((warnings++)) || true
  fi

  echo ""

  # --- RECOMMENDATIONS (optional) ---

  echo "Recommendations:"

  # MCP is optional — check if kanban MCP is configured
  if json_has_key "$config_file" '.mcp.kanban'; then
    echo "  [INFO] kanban MCP is configured"
  else
    echo "  [RECOMMENDATION] kanban MCP is not configured (optional, used by kanban-discipline skill)"
    ((recommendations++)) || true
  fi

  echo ""

  # --- Summary ---

  echo "Summary: $errors error(s), $warnings warning(s), $recommendations recommendation(s)"
  echo ""

  if [ "$errors" -gt 0 ]; then
    echo "Config does not meet handoff baseline."
    echo "Compare with the bundle example: $EXAMPLE_CONFIG"
    echo "To fix: merge missing fields from the example into your existing config, or"
    echo "  back up your config and re-run this script to create a fresh one from the example."
    return 1
  fi

  echo "Config validation passed."
  return 0
}

# --- Main ---

echo "=== OpenCode Handoff Config Validator ==="
echo ""

# Find existing config
CONFIG_FILE=""
if [ -f "$TARGET_DIR/opencode.json" ]; then
  CONFIG_FILE="$TARGET_DIR/opencode.json"
elif [ -f "$TARGET_DIR/opencode.jsonc" ]; then
  CONFIG_FILE="$TARGET_DIR/opencode.jsonc"
fi

if [ -z "$CONFIG_FILE" ]; then
  create_config_from_example
fi

if ! validate_config "$CONFIG_FILE"; then
  exit 1
fi
