#!/usr/bin/env bash
# install.sh — Unified installer for OpenCode handoff bundle.
# Creates managed symlinks inside ~/.config/opencode/.
#
# Source tree matches runtime layout 1:1. No adapter logic needed.
#
# Update flow: unlink all previously managed symlinks, then relink
# current bundle snapshot. User-owned unmanaged targets are never touched.
#
# State file: ~/.config/opencode/.opencode-handoff-state.json
# Format: {"managed_symlinks": {"agents/primary/dev-orchestrator.md": "/abs/path/to/bundle/agents/primary/dev-orchestrator.md", ...}}

set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${HOME}/.config/opencode"
STATE_FILE="$TARGET_DIR/.opencode-handoff-state.json"

CONFIG_VALIDATOR="$BUNDLE_DIR/scripts/validate-config.sh"

# Directory roots to discover (relative to bundle root)
# Source paths are identity-mapped to runtime paths.
BUNDLE_DIR_ITEM_ROOTS=("skills")

# File roots to discover (relative to bundle root)
BUNDLE_FILE_ITEM_ROOTS=("plugins" "agents/primary" "agents/subagents" "commands")

usage() {
  echo "Usage: $0 [--dry-run] [--uninstall] [--target-dir PATH]"
  echo "  --dry-run    Show what would be done without making changes"
  echo "  --uninstall  Remove managed symlinks and state file"
  echo "  --target-dir Install into a custom config directory"
  exit 0
}

DRY_RUN=false
UNINSTALL=false
FALLBACK_ITEMS=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
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
      STATE_FILE="$TARGET_DIR/.opencode-handoff-state.json"
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

if [ ! -d "$BUNDLE_DIR/agents" ]; then
  echo "Error: bundle directory not found at $BUNDLE_DIR"
  exit 1
fi

if [ "$DRY_RUN" = false ]; then
  mkdir -p "$TARGET_DIR"
fi

# --- State file helpers ---

load_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo '{"managed_symlinks":{}}'
  fi
}

save_state() {
  echo "$1" > "$STATE_FILE"
}

get_managed_dirs() {
  # Return newline-separated list of managed relative paths tracked in state
  local state
  state="$(load_state)"
  python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for d in data.get('managed_symlinks', {}):
    print(d)
" <<< "$state" 2>/dev/null || true
}

resolve_path() {
  local path="$1"
  python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$path" 2>/dev/null || true
}

discover_items() {
  local root
  for root in "${BUNDLE_DIR_ITEM_ROOTS[@]}"; do
    local root_path="$BUNDLE_DIR/$root"
    if [ ! -d "$root_path" ]; then
      continue
    fi

    while IFS= read -r item; do
      [ -n "$item" ] && printf '%s\n' "$item"
    done < <(
      find "$root_path" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r abs_path; do
        python3 -c "import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$abs_path" "$BUNDLE_DIR"
      done | sort
    )
  done

  for root in "${BUNDLE_FILE_ITEM_ROOTS[@]}"; do
    local root_path="$BUNDLE_DIR/$root"
    if [ ! -d "$root_path" ]; then
      continue
    fi

    while IFS= read -r item; do
      [ -n "$item" ] && printf '%s\n' "$item"
    done < <(
      find "$root_path" -mindepth 1 -maxdepth 1 -type f | while IFS= read -r abs_path; do
        python3 -c "import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$abs_path" "$BUNDLE_DIR"
      done | sort
    )
  done
}

set_managed_target() {
  local dir="$1"
  local target="$2"
  local state
  state="$(load_state)"
  if command -v jq &>/dev/null; then
    state="$(echo "$state" | jq --arg dir "$dir" --arg target "$target" '.managed_symlinks[$dir] = $target')"
  elif command -v python3 &>/dev/null; then
    state="$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
data['managed_symlinks'][sys.argv[1]] = sys.argv[2]
print(json.dumps(data))
" "$dir" "$target" <<< "$state")"
  fi
  save_state "$state"
}

remove_managed_target() {
  local dir="$1"
  local state
  state="$(load_state)"
  if command -v jq &>/dev/null; then
    state="$(echo "$state" | jq --arg dir "$dir" 'del(.managed_symlinks[$dir])')"
  elif command -v python3 &>/dev/null; then
    state="$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
data['managed_symlinks'].pop(sys.argv[1], None)
print(json.dumps(data))
" "$dir" <<< "$state")"
  fi
  save_state "$state"
}

# --- State validation: refuse cleanup if state points outside bundle ---

validate_state_safety() {
  local state
  state="$(load_state)"
  local unsafe_entries
  unsafe_entries="$(python3 -c "
import json, os, sys
data = json.load(sys.stdin)
bundle = os.path.realpath(sys.argv[1])
for d, target in data.get('managed_symlinks', {}).items():
    target_path = os.path.realpath(target)
    if os.path.commonpath([target_path, bundle]) != bundle:
        print(f'{d} -> {target}')
" "$BUNDLE_DIR" <<< "$state" 2>/dev/null || true)"

  if [ -n "$unsafe_entries" ]; then
    echo "ERROR: installer state contains paths outside the current bundle:"
    while IFS= read -r entry; do
      echo "  $entry (not under $BUNDLE_DIR)"
    done <<< "$unsafe_entries"
    echo ""
    echo "This may indicate state tampering or a moved bundle."
    echo "Refusing destructive cleanup. To proceed:"
    echo "  1. Verify the bundle location: $BUNDLE_DIR"
    echo "  2. Remove state file if stale: rm -f $STATE_FILE"
    echo "  3. Re-run this script to rebuild state from scratch."
    return 1
  fi
  return 0
}

# --- Fallback scan: discover existing managed symlinks when state is missing ---

fallback_scan() {
  local state
  state="$(load_state)"
  FALLBACK_ITEMS=""
  local has_entries
  has_entries="$(python3 -c "
import json, sys
data = json.load(sys.stdin)
sys.exit(0 if data.get('managed_symlinks') else 1)
" <<< "$state" 2>/dev/null && echo "yes" || echo "no")"

  if [ "$has_entries" = "no" ]; then
    while IFS= read -r item; do
      [ -z "$item" ] && continue
      # Identity mapping: runtime path equals bundle path
      local dst="$TARGET_DIR/$item"
      if [ -L "$dst" ]; then
        local resolved
        resolved="$(resolve_path "$dst")"
        if [ -n "$resolved" ] && [[ "$resolved" == "$BUNDLE_DIR"* ]]; then
          if [ -n "$FALLBACK_ITEMS" ]; then
            FALLBACK_ITEMS+=$'\n'
          fi
          FALLBACK_ITEMS+="$item"
          if [ "$DRY_RUN" = false ]; then
            set_managed_target "$item" "$resolved"
          fi
        fi
      fi
    done < <(discover_items)
  fi
}

# --- Uninstall ---

do_uninstall() {
  echo "=== OpenCode Handoff Uninstaller ==="
  echo ""

  fallback_scan

  # Validate state safety before unlinking
  if ! validate_state_safety; then
    return 1
  fi

  local managed_targets
  managed_targets="$(get_managed_dirs)"
  if [ -z "$managed_targets" ] && [ -n "$FALLBACK_ITEMS" ]; then
    managed_targets="$FALLBACK_ITEMS"
  fi

  if [ -z "$managed_targets" ]; then
    echo "No managed symlinks found."
    return 0
  fi

  while IFS= read -r target; do
    local dst="$TARGET_DIR/$target"
    if [ -L "$dst" ]; then
      if [ "$DRY_RUN" = true ]; then
        echo "[dry-run] Would remove symlink: $dst"
      else
        rm -f "$dst"
        echo "Removed symlink: $dst"
      fi
    fi
    if [ "$DRY_RUN" = false ]; then
      remove_managed_target "$target"
    fi
  done <<< "$managed_targets"

  if [ "$DRY_RUN" = false ]; then
    rm -f "$STATE_FILE"
    echo "State file removed."
    echo "Uninstall complete."
  fi
}

if [ "$UNINSTALL" = true ]; then
  do_uninstall
  exit 0
fi

# --- Install: unlink all managed, then relink all current ---

echo "=== OpenCode Handoff Installer ==="
echo "Bundle: $BUNDLE_DIR"
echo "Target: $TARGET_DIR"
echo ""

fallback_scan

CONFLICTS=0

# Phase 1: Unlink all previously managed symlinks
echo "Phase 1: Unlinking previously managed symlinks..."

# Validate state safety before unlinking
if ! validate_state_safety; then
  exit 1
fi

managed_targets="$(get_managed_dirs)"
if [ -z "$managed_targets" ] && [ -n "$FALLBACK_ITEMS" ]; then
  managed_targets="$FALLBACK_ITEMS"
fi

if [ -n "$managed_targets" ]; then
  while IFS= read -r target; do
    dst="$TARGET_DIR/$target"
    if [ -L "$dst" ]; then
      if [ "$DRY_RUN" = true ]; then
        echo "  [dry-run] Would unlink: $dst"
      else
        rm -f "$dst"
        echo "  Unlinked: $dst"
      fi
    fi
    if [ "$DRY_RUN" = false ]; then
      remove_managed_target "$target"
    fi
  done <<< "$managed_targets"
else
  echo "  No previously managed symlinks found."
fi

echo ""

# Phase 2: Relink current bundle snapshot
echo "Phase 2: Linking current bundle items..."

while IFS= read -r item; do
  [ -z "$item" ] && continue

  # Identity mapping: source path in bundle equals runtime target path
  src="$BUNDLE_DIR/$item"
  dst="$TARGET_DIR/$item"
  dst_parent="$(dirname "$dst")"

  if [ ! -e "$src" ]; then
    echo "  Warning: source for $item not found in bundle, skipping"
    continue
  fi

  if [ -e "$dst_parent" ] && [ ! -d "$dst_parent" ]; then
    echo "  CONFLICT: parent path $dst_parent exists and is not a directory"
    echo "    Remove or rename it manually, then re-run."
    ((CONFLICTS++)) || true
    continue
  fi

  if [ ! -d "$dst_parent" ] && [ "$DRY_RUN" = false ]; then
    mkdir -p "$dst_parent"
  fi

  if [ -L "$dst" ]; then
    # Unmanaged symlink at target — do NOT replace (FR-014 safety)
    existing_target="$(resolve_path "$dst")"
    echo "  CONFLICT: $dst is an unmanaged symlink -> ${existing_target:-unknown}"
    echo "    Remove or rename it manually, then re-run."
    ((CONFLICTS++)) || true

  elif [ -e "$dst" ]; then
    # Real file or directory — do NOT overwrite
    echo "  CONFLICT: $dst exists as a real file/directory"
    echo "    Remove or rename it manually, then re-run."
    ((CONFLICTS++)) || true

  else
    # Clean target — create symlink
    if [ "$DRY_RUN" = true ]; then
      echo "  [dry-run] Would create symlink: $dst -> $src"
    else
      ln -s "$src" "$dst"
      set_managed_target "$item" "$src"
      echo "  Linked: $dst -> $src"
    fi
  fi
done < <(discover_items)

echo ""
if [ "$CONFLICTS" -gt 0 ]; then
  echo "Installation incomplete: $CONFLICTS conflict(s) found."
  echo "Resolve conflicts and re-run."
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[dry-run] Would run config bootstrap/validation via: $CONFIG_VALIDATOR --target-dir $TARGET_DIR"
  exit 0
fi

echo ""
echo "Phase 3: Validating or creating config..."
if [ ! -x "$CONFIG_VALIDATOR" ]; then
  echo "ERROR: config validator not found or not executable: $CONFIG_VALIDATOR"
  exit 1
fi

if ! "$CONFIG_VALIDATOR" --target-dir "$TARGET_DIR"; then
  echo ""
  echo "Installer finished linking items, but config validation failed."
  exit 1
fi

echo ""
echo "Installation complete."
echo "Managed symlinks recorded in: $STATE_FILE"
echo "To update, pull changes in the bundle and re-run this script."
