# `kn` command reference

Exact surface of the installed CLI. Paths are user-level: `~/.config/kuber-nagibator/` and `~/kubernetes/`. Do not invent subcommands or flags — `kn <command> --help` is authoritative for the installed version.

## Subcommands and flags

| Command | Effect |
|---|---|
| `kn init [--force]` | Create `~/.config/kuber-nagibator/config.yaml` with defaults. User action: it does not add credentials. |
| `kn connect <cluster_id> [--env dev\|stage] [--namespace NS] [--no-tunnel] [--kubeconfig FILE]` | Full connect: fetch data-plane kubeconfig, deploy/reuse the proxy pod, start the tunnel, write the local kubeconfig. `--namespace` is only recorded in state (used by `kn reconnect` and the printed usage hint); it does not scope the tunnel, so kubectl still needs `-n`. |
| `kn clusters [--env dev\|stage] [--all]` | List clusters from the admin API as Name \| Internal ID \| MK8S ID \| Status. Default filters to RUNNING. |
| `kn status` | Last Environment, Last Cluster ID, Last Namespace, Tunnel PID (with `running`/`stopped`), Active Kubeconfig, managed `/etc/hosts` entries. |
| `kn envs` | Available environments with IAM URL, MK8S host, control-plane namespace. |
| `kn reconnect` | Re-run connect with the state's last cluster, environment and namespace. |
| `kn disconnect` | SIGTERM the tunnel and scale the remote proxy deployment to 0. |
| `kn cleanup` | disconnect plus `/etc/hosts` cleanup and state reset. Needs sudo. |
| `kn config show \| edit \| get <dotted.key>` | `show` renders the config with `service_key_secret` masked; `get` prints the raw value (used by scripts); `edit` opens the config in `$EDITOR`. |
| `kn ingress [<host>] [--namespace NS] [--port 443] [--ingress-ns ingress] [--ingress-svc ingress-nginx-controller-internal] [--wait-path /] [--no-open]` | Port-forward the ingress controller, add an `/etc/hosts` entry via sudo, optionally open a browser. |

`--env` defaults to `dev` for both `connect` and `clusters`. Errors are printed in red and exit non-zero; there is no machine-readable output mode, so parse the tables by eye.

## What `connect` does, step by step

1. Loads environment config; `service_key_id`/`service_key_secret` come from the environment block, else the global block, else `KN_SERVICE_KEY_ID`/`KN_SERVICE_KEY_SECRET`.
2. Resolves the argument to an mk8s id (below), unless `--kubeconfig FILE` is given; that file may be a plain kubeconfig YAML or a raw MK8S JSON response with a base64 `kube_config` field.
3. Fetches the data-plane kubeconfig via IAM token + `grpcurl` against the environment's MK8S gRPC host, and saves it to `~/kubernetes/cluster-<mk8s-id>.yaml` (secret material).
4. Ensures namespace `kuber-client-<user>`, updates ConfigMap `kuber-client-configs`, applies Deployment `kuber-client` running `kubectl proxy --port 8001 --reject-paths='^$'` (an empty reject list is what makes `exec`/`attach` upgrades work), restarts the rollout when the ConfigMap changed, waits up to 120s.
5. Writes `~/kubernetes/config-b-via-a.yaml` pointing the server at `http://localhost:8001`.
6. Starts a detached `kubectl port-forward deployment/kuber-client 8001:8001` against the control-plane kubeconfig, health-checks `http://localhost:8001/api`, retries up to 5 times (3s apart, restarting the pod when it is not ready), then records the PID in state.

`--no-tunnel` stops after step 3: kubeconfig only, no proxy, no tunnel. `--kubeconfig FILE` skips both the id resolution and the MK8S call, which is the escape hatch when the admin or MK8S API is unavailable.

Duration: 2-3 minutes cold. Run it in the bash tool with a timeout of 180s or more; a shorter timeout kills the CLI mid-rollout and leaves a half-configured tunnel.

## Cluster id resolution

`kn connect` accepts either identifier:

- Internal ID (from the admin panel / `kn clusters`) is resolved to the mk8s id through the environment's admin REST API. On success it prints `Resolved <name> -> mk8s <id>`.
- The admin API returning 404 means "no such internal id": the argument is then treated as an mk8s id, silently.
- The admin API being unreachable or answering 403 prints a warning and also falls back to treating the argument as an mk8s id.
- A cluster without an mk8s id (not provisioned / unhealthy status) is a hard error, not a fallback.

Consequence for agents: a typo can still "work" as an mk8s id and produce a confusing failure deeper in the MK8S call. Always confirm the identity of the target from `kn clusters` first, and prefer passing the mk8s id explicitly when the row shows one.

## State and files

- `~/.config/kuber-nagibator/config.yaml` — kubeconfig dir, local port (default 8001), image and object names, per-environment IAM URL, MK8S host, admin API URL, control-plane kubeconfig path, control-plane namespace, credentials. `kn init` writes absolute paths; a hand-edited `~/...` value comes back verbatim from `kn config get` and is not tilde-expanded by kubectl, so expand it in the shell (`${v/#\~/$HOME}`) when consuming that value.
- `~/.config/kuber-nagibator/state.yaml` — last environment, cluster id, internal id, namespace, tunnel PID, active kubeconfig. Secret-adjacent: do not print it.
- `~/kubernetes/config-b-via-a.yaml` — the tunnel kubeconfig every kubectl call must reference explicitly.
- `~/kubernetes/cluster-<mk8s-id>.yaml` — the raw data-plane kubeconfig. Secret: never print, never copy.
- `/tmp/kuber-nagibator-tunnel-<port>.log` — port-forward stdout/stderr; the first place to look when the tunnel dies.

## Missing components, reported exactly

- `kn` absent from PATH — the tool is not installed on this host. Stop; do not replicate its steps by hand.
- `kubectl` absent — nothing can be run through the tunnel.
- `grpcurl` absent — `connect` cannot reach the MK8S API (`grpcurl not found`); the user installs it.
- `~/.config/kuber-nagibator/config.yaml` absent — the user runs `kn init` and fills in credentials.
- Credentials empty or rejected — the user fixes `service_key_id`/`service_key_secret` or the environment variables; the agent never writes them.
- Admin API 403 in `kn clusters` — a missing admin-dataplatform grant. `connect` still works with an mk8s id, so ask for the mk8s id instead of treating this as a dead end.
- Port 8001 busy — `local_proxy_port` in the config is the user's setting; report it, do not edit the config.
