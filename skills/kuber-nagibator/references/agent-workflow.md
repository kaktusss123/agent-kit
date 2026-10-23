# Agent execution patterns for `kn` tunnels

## One explicit kubeconfig per kubectl call

Every bash tool call is a fresh shell. An `export KUBECONFIG=...` from an earlier call does not survive, and `~/.kube/config` is not the tunnel. Always pass the file explicitly. The path is configurable: it is `<kubeconfig_dir>/config-b-via-a.yaml`, and `~/kubernetes` is only the default. After a successful connect the path printed by `kn connect`, or `kn status` → Active Kubeconfig, is authoritative.

```bash
KDIR="$(kn config get kubeconfig_dir)"; KDIR="${KDIR/#\~/$HOME}"   # a literal ~ is not expanded by kubectl
K="$KDIR/config-b-via-a.yaml"
kubectl --kubeconfig "$K" get ns
kubectl --kubeconfig "$K" -n <ns> get pods -o wide
kubectl --kubeconfig "$K" -n <ns> logs <pod> --tail=200
kubectl --kubeconfig "$K" -n <ns> exec -it <pod> -- sh   # only when a shell is needed
```

The generated kubeconfig is a static `http://localhost:8001` server with a context that names no namespace, so an omitted `-n` lands in `default` — be explicit. Never edit `~/.kube/config` or the generated file, and never print the generated or cluster-specific kubeconfig content.

`exec`, `attach`, `port-forward` and `cp` work through the proxy because the remote proxy runs with an empty reject list. A `Forbidden` on upgrade means an old proxy pod is running behind the tunnel: `kn disconnect`, then `kn connect` (which redeploys the pod) rather than working around it.

## Prove the tunnel before work, not after

```bash
KDIR="$(kn config get kubeconfig_dir)"; KDIR="${KDIR/#\~/$HOME}"; K="$KDIR/config-b-via-a.yaml"
kn status                                                     # env, cluster, PID running/stopped, active kubeconfig
kubectl --kubeconfig "$K" get ns                              # the actual health proof
```

`kn status` only reports whether the port-forward process exists — it can be alive while the proxy pod is gone (control-plane pod eviction, cluster switch, network hiccup). Treat a failed `get ns` as tunnel breakage, and preserve evidence before acting, because every new port-forward truncates `/tmp/kuber-nagibator-tunnel-<port>.log`:

1. Copy the current log tail aside first: `tail -c 4000 /tmp/kuber-nagibator-tunnel-<port>.log > /tmp/kn-tunnel-last.log`, or read bounded error lines from it.
2. `kn status` — is the PID `stopped`, and is Last Cluster ID the cluster you need?
3. Exactly one reasoned recovery attempt: same cluster → `kn reconnect` (it reuses the stored environment and namespace); different or unknown → `kn disconnect`, then full `kn connect <id>` with a 180s+ timeout.
4. Still failing → read `/tmp/kn-tunnel-last.log`, then the proxy pod on the control plane: `kubectl --kubeconfig <control-plane-kubeconfig> -n kuber-client-$USER get pods,deploy`.

Never retry the tunnel blindly and never reconnect before capturing that tail; the same failure recurs and the evidence is gone.

A failed `kn connect` is secret-bearing: the ConfigMap update passes the whole data-plane kubeconfig as a `--from-literal` kubectl argument, and kubectl errors echo their argv. Send the output to a local capture file, extract bounded markers only — `grep -m3 -oE 'Failed to [a-z ]+|Error: .{0,120}' <capture-file> | head` — and never paste, quote or `cat` the raw output or the tunnel log.

## Reuse, and the single-tunnel slot

One data-plane tunnel exists at a time: one local port (8001), one proxy deployment in `kuber-client-<user>`. `kn connect` never stops the previous port-forward; it always starts a new one on that fixed port, so a connect that replaces a tunnel is an explicit two-step operation.

- Before any `kn connect` that replaces an existing tunnel — different cluster or different environment — run `kn disconnect` first, then connect. The rule is uniform; "same environment" is not an exception.
- Why silent replacement is dangerous: within one environment the ConfigMap rewrite and deployment restart leave the old port-forward alive, and it silently starts serving the new cluster (state may then record a new PID whose process failed to bind while the health check passed through the old one). Across environments the old forward keeps 8001, the new one cannot bind, and the health check can succeed against the old process — connect "succeeds" while serving the wrong environment.
- Reuse only when `kn status` shows a running PID, Last Cluster ID matches the target, and `get ns` succeeds. Reconnecting an already healthy tunnel costs up to 2-3 minutes and briefly breaks any in-flight kubectl session.
- When the target differs from the running tunnel, say so before acting: a kubectl command issued by another session mid-replacement will hit the wrong cluster or an empty API. Surface the replacement, then disconnect and connect.
- Never start a second concurrent `kn connect` for a different cluster while you still need the first one.

Reusing a tunnel is safe; assuming what it points at is not. Over a long session, re-check `kn status` before any destructive command.

## Control plane access without a tunnel (dev/stage)

The control-plane kubeconfigs are reachable directly and need no tunnel:

```bash
kubectl --kubeconfig "$(kn config get environments.dev.control_plane_kubeconfig)" get ns
```

The value is printed verbatim: `kn init` stores an absolute path, but a hand-edited `~/...` entry is not expanded by kubectl, so expand it first.

Use this for control-plane questions only — the proxy namespace/pod state, and nothing that belongs to the user's data-plane cluster. `kn config get` prints raw values, so restrict it to path and namespace keys (`environments.<env>.control_plane_kubeconfig`, `environments.<env>.control_plane_namespace`, `kubeconfig_dir`), never to `service_key_*`.

## Ingress-only UIs without sudo

`kn ingress` is hostile to an agent session: it edits `/etc/hosts` through sudo, opens a browser, and then blocks in the foreground until Ctrl+C. Do the equivalent with plain kubectl and `curl`:

```bash
K=~/kubernetes/config-b-via-a.yaml   # default; derive it from kubeconfig_dir as above
kubectl --kubeconfig "$K" -n ingress get svc                      # confirm the ingress service name
kubectl --kubeconfig "$K" -n ingress port-forward svc/ingress-nginx-controller-internal 8443:443 &
curl -sk --resolve app.example.com:8443:127.0.0.1 https://app.example.com:8443/
```

`--resolve` supplies the SNI/Host the ingress needs without touching DNS or `/etc/hosts`; `-k` covers the internal certificate. Use an unprivileged local port (8443, not 443). Kill the port-forward when done. For an arbitrary data-plane service, prefer `port-forward svc/<name> <local>:<remote>` over ingress at all.

## Cleanup

```bash
kn disconnect      # SIGTERM the tunnel, scale the remote proxy deployment to 0
kn status          # Tunnel PID must show "-" (or the process gone)
```

Run it whenever cluster work ends, including after an aborted or failed attempt: an orphaned proxy deployment keeps running on the control plane until someone scales it down. `kn disconnect` leaves the kubeconfig files in place, so a later kubectl call against the tunnel kubeconfig fails or hangs — that is expected after a disconnect, not a new bug. `kn cleanup` is only for when the user also wants `/etc/hosts` entries and state cleared, and it needs sudo.

A failed connect to a different environment is the sharp edge: state is written only after a fully successful connect, so `kn disconnect` afterwards scales the deployment named by the OLD environment and leaves the target environment's proxy running. After any failed connect, inspect the target read-only:

```bash
kubectl --kubeconfig "$(kn config get environments.<target-env>.control_plane_kubeconfig)" \
  -n "kuber-client-$USER" get deploy kuber-client
```

If it is running with no tunnel, tell the user and offer two cleanup options: retry `kn connect` for that environment and then `kn disconnect`, or an explicitly user-approved `scale deployment/kuber-client --replicas=0` with that same control-plane kubeconfig. An authorized failed-connect cleanup is the only permitted exception to "the proxy namespace is tunnel infrastructure"; it is still a separate decision, never part of the user's cluster task.
