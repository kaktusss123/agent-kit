#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

usage() {
  cat <<'USAGE'
Usage: publish-report.sh [--project NAME] <report.html>

Publish a standalone HTML report to the configured public S3 website bucket.
Configuration is read from:
  ${AGENT_KIT_REPORTS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-kit/reports.env}
USAGE
}

fail() {
  printf 'publish-report: %s\n' "$*" >&2
  exit 2
}

slug() {
  printf '%s' "$1" \
    | tr '[:space:]' '-' \
    | tr -cd '[:alnum:]_.-' \
    | sed -E 's/-+/-/g; s/^[.-]+//; s/[.-]+$//'
}

project="reports"
file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || fail '--project requires a value'
      project="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      [ "$#" -eq 1 ] || fail 'expected exactly one report path after --'
      file="$1"
      shift
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      [ -z "$file" ] || fail 'expected exactly one report path'
      file="$1"
      shift
      ;;
  esac
done

[ -n "$file" ] || { usage >&2; exit 2; }
[ -f "$file" ] || fail "report not found: $file"
case "$file" in
  *.html|*.htm) ;;
  *) fail 'report must be an .html or .htm file' ;;
esac

config_path="${AGENT_KIT_REPORTS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-kit/reports.env}"
if [ -f "$config_path" ]; then
  # The config is user-owned local shell syntax. Keep secrets in the AWS CLI
  # credential store; this file should only select a profile and destination.
  # shellcheck source=/dev/null
  . "$config_path"
fi

: "${AWS_PROFILE:?publish-report: AWS_PROFILE is not set; configure $config_path}"
: "${REPORTS_ENDPOINT_URL:?publish-report: REPORTS_ENDPOINT_URL is not set; configure $config_path}"
: "${REPORTS_BUCKET:?publish-report: REPORTS_BUCKET is not set; configure $config_path}"
: "${REPORTS_PUBLIC_URL:?publish-report: REPORTS_PUBLIC_URL is not set; configure $config_path}"

command -v aws >/dev/null 2>&1 || fail 'aws CLI is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required for public verification'
command -v cksum >/dev/null 2>&1 || fail 'cksum is required to generate a collision-resistant key'

safe_project="$(slug "$project")"
[ -n "$safe_project" ] || fail 'project name is empty after sanitization'

base="$(basename "$file")"
stem="${base%.*}"
safe_stem="$(slug "$stem")"
[ -n "$safe_stem" ] || safe_stem='report'

date_utc="$(date -u +%Y-%m-%d)"
epoch="$(date -u +%s)"
checksum="$(cksum "$file" | awk '{print $1}')"
key="${safe_project}/${date_utc}/${safe_stem}-${epoch}-${checksum}.html"

aws s3 cp "$file" "s3://${REPORTS_BUCKET}/${key}" \
  --profile "$AWS_PROFILE" \
  --endpoint-url "$REPORTS_ENDPOINT_URL" \
  --content-type 'text/html; charset=utf-8' \
  --only-show-errors

public_url="${REPORTS_PUBLIC_URL%/}/${key}"
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT

if ! curl -fsSL -D "$headers" -o /dev/null "$public_url"; then
  printf 'publish-report: upload succeeded but public GET failed: %s\n' "$public_url" >&2
  printf '%s\n' "$public_url"
  exit 1
fi

if ! grep -Eiq '^content-type:[[:space:]]*text/html([;[:space:]]|$)' "$headers"; then
  printf 'publish-report: upload succeeded but public Content-Type is not text/html: %s\n' "$public_url" >&2
  printf '%s\n' "$public_url"
  exit 1
fi

printf '%s\n' "$public_url"
