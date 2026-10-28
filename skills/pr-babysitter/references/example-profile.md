# Example profile
One filled-in set of seams, kept as the reference answer sheet:

- **deploy trigger**: green push to `main` runs a CI `deploy` job that POSTs
  the SHA to the server; the server updates itself and restarts its systemd
  units (server + node). Base URL: repo variable `ZAVOD_DEPLOY_URL`.
- **blast radius**: `POST $DEPLOY/api/sessions/reconcile` → per-node
  runtimes; `capacity.live` is the count, `activity.at` the liveness stamp.
- **graceful stop**: `POST $DEPLOY/api/sessions/:id/stop` (record survives,
  resumable).
- **author channel**: `POST $DEPLOY/api/sessions/:id/command` with
  `{"command":"steer","params":{"message":"…"}}` — queues while the author's
  turn runs.
- **verification surface**: `GET /api/health` (revision), `GET
  /api/system/update` (terminal job state), `GET /api/nodes` (auto nodes
  report the new revision; manual-mode nodes legitimately lag). Smoke:
  create a throwaway session (also proves pre-session dependency updates,
  e.g. `agent-kit update`), `getState`, stop, delete.
