---
name: fleet
description: "Autonomous natural-language tasks on the Fleet-managed homelab: locate machines and services in the fleet inventory, run read-only diagnostics over the agent SSH profile, execute scoped authorized changes with prestate/rollback/health verification, and apply the SSH access baseline to one explicit target. Use for any request about homelab machines, guests, services, containers, DNS, or fleet itself; not for generic Linux/SSH/Docker help unconnected to fleet targets."
---

# Fleet homelab operations

Fleet is the inventory and access layer of the homelab: `inventory/fleet.json` is the authoritative machine registry, the `fleet` CLI reads it (and the live Proxmox cluster, read-only unless asked), `~/.fleet/ssh-agent.conf` is the dedicated agent SSH profile, and an Ansible playbook applies the SSH access baseline. This skill operates Fleet-managed machines through that contract. Generic Linux, SSH, or Docker questions with no fleet target are ordinary work, not this skill.

## Mandatory references

- Before running anything against fleet: read `references/access.md` — CLI discovery, registry resolution, agent profile, host-key policy.
- Before any mutation, baseline run, or on-target diagnosis: read `references/maintenance.md` — authorization classes, verification discipline, OS/runtime differences, baseline procedure.
- Before OPNsense API access or any proxy-gw-v2 route/firewall/sing-box work: read `references/opnsense.md` — API key handling, the alias-only API surface, and the LAN reply-symmetry guardrails.

## Non-negotiables

- Explicit target only. Resolve a machine by its exact `name` from the current inventory; an unknown alias stops with candidates, never a guess. No random guests, no guessed IPs, no "similar enough" hosts.
- Agent identity only. Administrative SSH uses the agent profile (`ssh -F ~/.fleet/ssh-agent.conf <name>`), proven effective with `ssh -G -F` before the first real connection. Never fall back to the human profile, `ssh_user`, or root identities; never copy private keys around. The sole narrow exception is an owner-approved baseline/bootstrap run (`references/maintenance.md`) — never an automatic fallback for ordinary diagnosis.
- Strict host keys. An unknown or changed host key is a hard stop. Confirmation only via an independent trusted channel, and known_hosts edits only as the controlled, independently verified install or replacement defined in `references/access.md` — never auto-accept, never to make an unverified connection pass.
- Side-effect isolation. OPNsense, DNS (Pi-hole), and Proxmox infrastructure are never changed as a side effect of a machine task; changes there are separate owner decisions (`references/maintenance.md`). Stopped guests are never started as a workaround — the agent profile excludes non-running guests by design.
- Safe observation (gates in `references/maintenance.md`, output rules in `references/access.md`). A `healthcheck`/`doctor`/`check`/`test` name never proves a command is non-mutating: establish installed-version init/migration/DB-write behavior from source/docs or a proven safe mode before any app CLI (`--help` or the name alone never proves safety); on unknown safety use another observation or record the gap, never trial execution. Prefer process/supervisor state, field-selected Docker queries, and only known-safe HTTP GET — any other GET can mutate. Filter on target by allowlisted field names before output: never full configs, container env, secret values, or raw logs; secrets appear as key names/paths only.
- Fleet repository mutations — registry edits, `inventory refresh` outputs, key policy files — go through `skill://git-task` managed worktrees, never the primary Fleet checkout.

## Flow

1. Discover the CLI (`references/access.md`): `command -v fleet`, else the Fleet checkout named by the user or task context. An absent CLI is reported as an exact missing component; diagnostics do not improvise a replacement.
2. Service catalog (optional, same resolved root — an explicitly pinned managed worktree wins per `references/access.md`): if `<root>/docs/services/README.md` exists, consult the index plus the relevant service page and `COVERAGE.md` when present before service-specific investigation. Resolve the page's host against the CURRENT registry (exact-name rule above); dated OBSERVED/DOCUMENTED/INFERRED/UNKNOWN labels are evidence, not current runtime — verify on the target. A missing catalog is normal (old checkout): fall back to current inventory + bounded discovery, never `fleet update`/`install` to fetch it, never bypass access/host-key/identity gates, never treat it as operator authorization.
3. Resolve the target from the current registry: exact-name match, or metadata search (`name`, `roles`, `notes`) over the full registry JSON, then bounded read-only evidence on candidates. The registry is authoritative but possibly stale.
4. Classify the request — diagnostics, scoped change, broad/destructive (`references/maintenance.md`) — and stay inside that class; a wider class needs explicit new authorization.
5. Verify: for changes, capture prestate, validate config before activation, apply the minimal targeted action, check actual application health from observed runtime, roll back on failure. For connection failures, triage by failure class — auth vs network vs local gate vs host key (`references/access.md`) — instead of retrying wider.

## Completion

Done means: the target was resolved explicitly; every command ran under the correct class and the agent identity; conclusions rest on observed output (OS family, init system, container state), not assumptions; and any Fleet repository change was committed through the git-task path.
