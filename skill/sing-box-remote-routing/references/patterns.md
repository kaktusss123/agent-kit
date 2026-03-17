# Safe Patterns

## Host Inspection

Use this order before changing anything:

```bash
ssh root@HOST "ls -la /etc/sing-box"
ssh root@HOST "command -v systemctl || true; command -v service || true; command -v rc-service || true"
ssh root@HOST "command -v sing-box && sing-box version"
ssh root@HOST "sing-box check -c /etc/sing-box/config.json"
ssh root@HOST "ls /etc/sing-box/rules | grep -Ei 'telegram|tracker|rutracker|pt|torrent'"
```

## Tracker-Only Proxy Pattern

Use this pattern when the user wants blocked trackers reachable through the proxy but does not want torrent payload traffic proxied.

1. Add or reuse tracker rule-sets in `route.rule_set`.
2. Add a DNS rule that sends tracker rule-sets to the remote DNS server.
3. Add a route rule that sends tracker rule-sets to `proxy`.
4. Do not add a `protocol: bittorrent` rule unless the user explicitly requests it.

Typical rule-set tags:

- `geosite-rutracker`
- `geosite-category-public-tracker`
- `geosite-trackernetwork`

## Telegram Proxy Pattern

Use the existing Telegram rule-sets first:

- `geosite-telegram`
- `geoip-telegram`

If Telegram is already proxied in route rules, only add or adjust DNS behavior when resolution must also bypass local censorship.

## Backup And Rollout Pattern

```bash
ssh root@HOST 'set -euo pipefail; \
timestamp=$(date +%Y%m%d_%H%M%S); \
backup="/etc/sing-box/config.json.backup.${timestamp}"; \
cp -p /etc/sing-box/config.json "$backup"; \
sing-box check -c /etc/sing-box/config.json.new; \
mv /etc/sing-box/config.json.new /etc/sing-box/config.json; \
service sing-box restart'
```

## Rollback Pattern

Use rollback immediately if restart fails or `pidof sing-box` returns nothing:

```bash
ssh root@HOST 'cp -p /etc/sing-box/config.json.backup.TIMESTAMP /etc/sing-box/config.json && service sing-box restart'
```

## Notes

- `jq` can fail on configs with trailing commas even when `sing-box check` accepts them.
- BusyBox hosts may not have `python3`, `jq`, or `systemctl`.
- Keep the proxy server destination domain on `direct`.
- Prefer idempotent string or fragment updates when the config is not strict JSON.
