# Fleet maintenance contract

## Authorization classes

Classify by blast radius, not vocabulary: "just restart it" on one named service is scoped; "make it work" is not authorization for anything wider than the named target.

1. **Diagnostics** — read-only observation of an explicitly resolved target, scoped to the request: CPU/load, RAM, disk space and inodes, listening ports, service status under the observed init system (systemd vs OpenRC vs busybox — see below), bounded Docker facts (`docker ps -a`, picked `docker inspect` fields, `docker logs --tail`), and an actual application probe (HTTP or functional command) when the question is about the app. No per-command user approvals: an agreed diagnostic request covers the read-only commands needed to answer it. Still one target at a time — no fleet-wide sweeps without a new request.
2. **Scoped change** — the user explicitly requested this outcome on this target: restart a named service, fix its config, roll back a bad change. The agreement covers the targeted actions the fix needs (including the service restart and any packages/account changes the task explicitly includes — only those beyond the agreed task need new approval), and requires the full discipline:
   - capture prestate: service status and enabled state, a copy of any config about to change, relevant container ids/images;
   - validate config before activation (`<daemon> -t`, `docker compose config`, or the service's own check) — on failure, stop and report, don't apply;
   - apply the minimal action: targeted restart/reload, never a host reboot or "restart everything";
   - verify actual application health from observed runtime — an HTTP probe or functional command and the relevant log lines, not just "unit is active";
   - on failure: restore prestate (config back, restart), report what happened and what was restored.
3. **Broad / destructive / network-infrastructure** — anything beyond the named target: package installs/upgrades not in the agreed task, firewall or OPNsense changes, DNS records (`fleet dns apply`/`restore`), Proxmox guest lifecycle (start/stop/create/delete), account or key changes, and changing legacy admin access paths. These require explicit new authorization naming the change; as side effects of a machine task they are forbidden. Read-only evidence is fine (`fleet dns check`/`plan` output can be reported); execution is an owner action.

The Fleet baseline (below) is its own privilege-grant gate: it creates accounts and grants NOPASSWD sudo, so it always needs the owner's explicit approval for each run — an approved service fix never covers it.

## OS and runtime differences — observe, don't assume

- Read facts on the target before using init commands: `/etc/os-release`, `/etc/alpine-release`, `command -v systemctl`. Debian/Ubuntu: systemd — `systemctl status|restart|is-enabled <unit>`, `journalctl -u <unit>`. Alpine: OpenRC — `rc-service <svc> status|restart`, `rc-update show`; busybox userland (some coreutils long options unavailable, `ps`/`tail` differ, no journalctl — logs in `/var/log` or via `docker logs`). No universal Debian assumptions: the fleet deliberately mixes families.
- Docker: diagnose from the observed runtime — `docker ps -a`, `docker inspect` with picked fields (state, image, port bindings, restart policy), `docker logs --tail`. Don't assume compose files, project names, or container names; find them via inspect. The container's OS family can differ from the host's: check inside with `docker exec <c> cat /etc/os-release` when init or package commands matter.
- Proxmox: the agent reaches guests through the agent SSH profile; fleet's own transports reach PVE for `check`/`refresh`/dns reads. Direct PVE node SSH and `pct`/`qm` mutations by the agent are class 3. Read-only diagnosis through an already-authorized, trusted console channel is the narrow allowance (`references/access.md`) — it is evidence, never a delivery path for changes.

## Baseline (SSH access) application

The Ansible playbook applies the additive baseline — `admin` and `agent` accounts, five policy key slots, full `NOPASSWD:ALL` sudo for both (an owner-approved grant) — to exactly one explicit target.

The agent-identity rule has one narrow explicit exception: an owner-approved baseline/bootstrap run connects as the inventory `ssh_user` (that is the bootstrap's job), and a non-root bootstrap user must have proven passwordless sudo (`sudo -n true`) before the run. This is never an automatic fallback for ordinary guest diagnosis — diagnostics never drop to `ssh_user`, root, or the human profile.

1. Environment: the Fleet checkout's project venv (`.venv` from `requirements-ansible.txt`, pinned collections). If it is absent, report that as a readiness gap and stop — setting it up is an explicit setup decision, never global Python, never improvised versions. Required env, anchored at the resolved Fleet root (`$FLEET_ROOT`), with the exact target assigned first so it is never an unquoted placeholder:
   ```
   cd "$FLEET_ROOT"
   target=<exact-name>   # the single approved inventory name
   export ANSIBLE_CONFIG="$PWD/ansible/ansible.cfg"
   export ANSIBLE_COLLECTIONS_PATH="$PWD/.venv/collections"
   .venv/bin/ansible-inventory -i "$PWD/ansible/inventory/fleet_inventory.py" --graph          # read-only planning
   .venv/bin/ansible-playbook -i "$PWD/ansible/inventory/fleet_inventory.py" \
       "$PWD/ansible/baseline.yml" -e "fleet_target=$target" --check --diff                     # owner-approved preview
   .venv/bin/ansible-playbook -i "$PWD/ansible/inventory/fleet_inventory.py" \
       "$PWD/ansible/baseline.yml" -e "fleet_target=$target"                                  # apply
   ```
   OS support is decided from Ansible facts on the target: Alpine, Debian, Ubuntu; Alpine guests additionally need python3, sudo, bash, and shadow preinstalled — the playbook installs no packages, so missing prerequisites stop it.
2. Prechecks: `fleet keys lint` passes (it is a deployment gate); the target resolves into the `fleet_baseline` dynamic-inventory group — `baseline: true` is eligibility, not proof the baseline was applied (group membership never proves the record is current). Before any preview or apply, run a fresh `<same-chosen-Fleet-root>/bin/fleet inventory check --format json` — the same Fleet root (same inventory and policy candidate) as the planned run, never an unrelated PATH-primary `fleet` — and inspect the actual report: refuse the target when its identity/config/source observation is unavailable or a relevant `id-identity-changed`, `id-reused`, or conflict finding on it is unresolved; the user resolves findings through the managed Fleet RepoOwner, and a changed identity is never auto-accepted. Inventory opt-in and the absence of previous findings are not proof of current identity; warnings about other, unrelated hosts do not block the run when the explicit target's own identity is observed and resolved.
3. Owner approval for this run — an explicit user request to apply the baseline to the named host is the approval; don't demand a redundant per-command confirmation. The `--check --diff` preview is part of the same approved run (check mode still writes temp files on the target). Approval for one target never carries to another.
4. Single explicit target only: `-e "fleet_target=$target"`; `--limit` is unsupported and must not appear; `--start-at-task`/`--skip-tags` cannot bypass the gates and must not be attempted.
5. Before apply: demonstrate the old access paths work — the bootstrap `ssh_user` connection (and its `sudo -n true` if non-root) — and capture before-copies of exactly what recovery needs: current `authorized_keys` for existing accounts and a pre-existing `/etc/sudoers.d/fleet-baseline` if present. Nothing else (e.g. sshd config) is copied unless the run touches it. Old access paths must survive byte-for-byte.
6. After apply: verify from observed runtime — a real SSH probe on the agent profile (`ssh -F ~/.fleet/ssh-agent.conf <name> sudo -n id -u` must print `0`), `fleet ssh check --profile agent`, the admin account through its approved operator path, and a fresh `fleet keys lint`. Report which access was granted (accounts, sudo level, keys). Application or service health is unrelated to the baseline and must not be claimed as verified. A baseline audit states what current access/runtime was actually observed versus the inventory intention — no marker state is added.

Rollback (owner decision, never automatic): first verify the old access path still works (bootstrap `ssh_user` login and sudo), and only then remove what this run added — never the reverse order. A pre-existing `/etc/sudoers.d/fleet-baseline` is restored from its before-copy if it existed, and removed only if this run newly added it; prior baseline admin access (accounts, keys recorded before this run) is never deleted wholesale; from `authorized_keys` remove only the lines the apply actually added (compare with the before-copy — pre-existing matching lines stay). Fleet never deletes accounts on its own.

## New guest registration — compact flow

1. Guest creation in Proxmox is a separate owner decision; there is no fleet provisioning CLI. Never create/start/stop/delete guests as part of another task.
2. Guest prerequisites: working SSH for the chosen bootstrap `ssh_user`, python3 and sudo installed; Alpine additionally bash and shadow. A non-root bootstrap user must prove `sudo -n true`.
3. Register and opt in before any baseline run: in a managed Fleet worktree (`skill://git-task`) run `<managed-worktree>/bin/fleet inventory refresh` — the worktree's OWN executable — to capture the discovered record, validate identity/conflict findings (`id-reused`, `id-identity-changed` are owner-reviewed), fill owner fields (`site`, `roles`, `notes`), set `baseline: true` only as an explicit owner opt-in decision — never by default — and commit through the git-task path.
4. Keys and controller prep: dedicated key slots only — `ansible/keys/public-keys.json` stores full public key lines; the controller keypair from `fleet keys prepare-agent` keeps its private half controller-local; `fleet keys lint` is the gate. No console delivery of keys, no root fallback.
5. Baseline and verification: the owner-approved single-target run (above) creates the `agent`/`admin` accounts, installs the policy keys, and is verified per its post-apply steps.
6. External physical/VPS machines enter via the manual metadata route (owner-provided facts recorded by hand); the existing exclusions (PVE nodes, templates, OPNsense/HAOS, physical Macs, external VPS from agent access) are preserved as-is.

## Fleet repository changes

Registry edits (`baseline`, `ssh_user`, names), `inventory refresh` outputs, and key-policy changes are Fleet repository mutations: route them through `skill://git-task` — managed worktree, checkpoint commit. Never edit the primary Fleet checkout. The CLI resolves the registry from its own source root, not the current directory, so a `cd` into the managed worktree does NOT redirect a PATH-installed `fleet`: invoke `<managed-worktree>/bin/fleet inventory refresh` explicitly and take every mutation-targeting source path from that worktree; never bypass the routing with direct Python writes or file edits into the primary checkout. A corrupt registry is reported for owner repair, never regenerated.
