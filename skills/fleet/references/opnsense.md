# OPNsense and proxy-gw-v2 contract

Conventions: dated facts below are read-only observations from 2026-10-18, not live state — verify on target before acting. Paths like `docs/services/...` are relative to the Fleet checkout root; `~/.config/fleet/...` and `~/.fleet/...` are controller-home paths.

## OPNsense access

- OPNsense (VM 101, 192.168.1.1) is excluded from agent SSH by design; no fleet identities exist on it. All OPNsense changes (firewall, NAT, aliases, DHCP) are owner-class: read-only evidence by default, explicit authorization to mutate.
- API credentials on the controller: `~/.config/fleet/OPNsense.internal_root_apikey.txt` (two lines: `key=...`, `secret=...`, mode 600) and curl netrc `~/.config/fleet/opnsense-netrc` (machine 192.168.1.1 and machine 127.0.0.1, mode 600). Never print, copy, or commit key/secret values; reference paths only.
- GUI and API are on plain HTTP port 80: `http://192.168.1.1`. From the services subnet (192.168.10.0/24) only port 80 answers; 443 and 53 do not. Controller DNS goes through pihole-services (192.168.10.20).
- Verified API surface (2026-10-18): only `GET /api/firewall/alias/searchItem` answers; firewall-rule/backup/core/diagnostics endpoints return 404. Read aliases:
  `curl -s --netrc-file ~/.config/fleet/opnsense-netrc 'http://192.168.1.1/api/firewall/alias/searchItem?rowCount=100'`
- If direct HTTP breaks, tunnel via an agent-accessible LAN LXC: `ssh -F ~/.fleet/ssh-agent.conf docker -o ExitOnForwardFailure=yes -N -L 18443:192.168.1.1:80`, then curl `http://127.0.0.1:18443/...`.
- Credentials travel cleartext over LAN HTTP (owner-accepted 2026-10-18); do not add new secret traffic over this path without an explicit owner decision.
- Full documentation: `docs/services/opnsense.md` in the fleet checkout (fleet repo branch `docs/opnsense-access`, pending merge as of 2026-10-18).

## proxy-gw-v2 — LAN reply-symmetry guardrails

- proxy-gw-v2 (VM 122, 192.168.10.22) runs sing-box with nft interception; proxied LAN flows go client → OPNsense → gateway. OPNsense pf is stateful: replies of proxied (DNAT-intercepted) flows MUST return via OPNsense, or pf kills the flow (~66 KB in).
- Symmetry is implemented on the gateway: nft table `inet lansym` marks `ct status dnat` packets to 192.168.10.30 with fwmark 0x2a; `ip rule pref 8000 fwmark 0x2a lookup 100`; table 100 routes 192.168.10.30/32 via 192.168.10.1. Managed by lan-proxy-symmetry.service (`/etc/nftables.d/50-lan-proxy-symmetry.nft`, `/usr/local/sbin/apply-lan-proxy-symmetry.sh`).
- HARD RULE: never delete routes, nft rules, or sing-box config on proxy-gw2/proxy-gw-v2 without an explicit owner decision; "stray-looking" static routes there may be load-bearing (incident 2026-10-18: deleting the pin-routes for .30/.15 broke proxied transfers; repaired by lansym).
- SSH from the services subnet to proxy-gw-v2 works only while the first rule of `inet sing-box prerouting_prematch` (`ip saddr 192.168.10.0/24 tcp dport 22 counter return`) exists; the drop-in `/etc/systemd/system/sing-box.service.d/20-lan-ssh-exempt.conf` re-applies it after each sing-box start. Do not remove either.
- Any change on proxy-gw-v2 (routes, nft, sing-box) is owner-class; verify with `sudo -n nft list chain inet lansym` counters before and after.
- Full documentation: `docs/services/proxy-gw-v2.md` in the fleet checkout (branch `docs/proxy-gw-symmetry`, pending merge as of 2026-10-18).
