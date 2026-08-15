#!/usr/bin/env bash
set -euo pipefail

hour="$(date +%H)"
hour=$((10#$hour))

# Foundation Models:
# 20:00–23:59
# 00:00–09:59
if (( hour >= 20 || hour < 10 )); then
    printf '%s\n' "fm"
else
    printf '%s\n' "balanced"
fi
