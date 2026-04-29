---
name: sing-box-remote-routing
description: Safe workflow for updating remote sing-box routing over SSH with rule-set discovery, backup, validation, restart, and rollback
user-invocable: true
metadata:
  version: 1.0.0
  author: OpenCode
---

# Remote sing-box Routing

Use this skill when the user wants to change routing on a remote sing-box host over SSH.

## Triggers

- `update remote sing-box routing` - Apply routing changes on a remote host.
- `route Telegram through proxy` - Keep Telegram on the proxy path.
- `add blocked trackers through proxy` - Proxy tracker domains without touching peer traffic.
- `backup and restart sing-box` - Use the full safe rollout workflow.

## Defaults

| Item | Default |
|------|---------|
| Config path | `/etc/sing-box/config.json` |
| Rules dir | `/etc/sing-box/rules` |
| Staged config | `/etc/sing-box/config.json.new` |
| Backup pattern | `config.json.backup.YYYYmmdd_HHMMSS` |
| Restart method | Detect `systemctl`, `service`, or `rc-service` |
| Tracker policy | Proxy tracker domains only unless the user explicitly asks to proxy BitTorrent traffic |

## Process

### Phase 1: Inspect Remote State

1. Confirm the target host, config path, and rules directory.
2. List `/etc/sing-box`, detect the service manager, and check `sing-box version`.
3. Validate the current config with `sing-box check -c` before planning changes.
4. Search existing `.srs` files first and prefer reusable rule-set tags over custom domain lists.
5. Inspect the active config structure and note anchors for minimal edits.

**Verification:** You know the restart command, outbound tag, relevant rule-set files, and whether the current config already passes validation.

### Phase 2: Plan Minimal Routing Changes

1. Reuse existing rule-sets when possible, such as `geosite-telegram`, `geoip-telegram`, `geosite-rutracker`, `geosite-category-public-tracker`, and `geosite-trackernetwork`.
2. Add or update DNS rules when domain-based traffic must resolve through the proxy path.
3. For blocked trackers, route tracker domains through `proxy` but keep BitTorrent peer traffic unchanged unless the user explicitly requests it.
4. Preserve existing exceptions like LAN ranges and the proxy server endpoint on `direct`.
5. Keep edits idempotent and avoid reformatting the whole file when only a few fragments need to change.

**Verification:** You have exact rule-set tags, insertion points, and the smallest safe config delta.

### Phase 3: Apply, Validate, And Roll Back If Needed

1. Write the candidate config to `config.json.new` instead of editing the live file first.
2. Create a timestamped backup of the live config.
3. Validate the staged config with `sing-box check -c /etc/sing-box/config.json.new`.
4. Replace the live config and restart the detected service.
5. Verify `pidof sing-box`, inspect recent logs, and confirm the expected rules are present.
6. If restart or verification fails, restore the backup immediately and restart again.

**Verification:** Backup exists, validation passes, service is running, and rollback is available.

## Rule Selection Guidance

- Prefer existing `.srs` assets over new custom rule files.
- Add a matching DNS rule when censorship blocks tracker or Telegram resolution.
- Use `protocol: bittorrent` only when the user explicitly wants torrent traffic itself routed or filtered.
- Keep the proxy transport destination domain on `direct` so the outbound can connect.
- Assume BusyBox or OpenWrt style service management until proven otherwise.

## Command Patterns

```bash
ssh root@HOST "ls -la /etc/sing-box"
ssh root@HOST "command -v systemctl || true; command -v service || true; command -v rc-service || true"
ssh root@HOST "command -v sing-box && sing-box version"
ssh root@HOST "sing-box check -c /etc/sing-box/config.json"
ssh root@HOST "ls /etc/sing-box/rules | grep -Ei 'telegram|tracker|rutracker|pt'"
```

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Editing the live config first | A bad write can break the service immediately | Stage to `config.json.new`, validate, then swap |
| Assuming `systemd` | Routers often use BusyBox or OpenWrt init scripts | Detect `systemctl`, `service`, or `rc-service` |
| Proxying all torrent traffic by default | Users often need tracker access only | Route tracker domains only unless asked otherwise |
| Using `jq` as the source of truth | Trailing commas or JSONC-like syntax can fail strict parsers | Inspect raw config and patch anchored fragments |
| Rewriting unrelated rules | Broad edits can change existing behavior | Apply the smallest specific delta |

## Verification

After execution:

- [ ] A backup path is created and reported.
- [ ] `sing-box check` passes on the staged config.
- [ ] Required `rule_set` entries exist in `route.rule_set`.
- [ ] DNS and route rules point to the intended `server` or `outbound`.
- [ ] The service restarts successfully and `pidof sing-box` returns a PID.
- [ ] A rollback path is ready if runtime verification fails.

## Final Report Format

- Host, config path, and backup path.
- Rule-sets reused or added.
- DNS changes.
- Route changes.
- Restart command used.
- Validation result and rollback status.

## References

- [Patterns](references/patterns.md) - Safe examples for tracker-only and Telegram routing updates.
