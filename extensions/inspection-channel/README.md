# inherited inspection channel

Optional machine-facing read channel for a live agent-kit Pi process. It is inert unless Pi inherits valid pipe descriptors in both:

- `AGENTKIT_INSPECT_REQUEST_FD`
- `AGENTKIT_INSPECT_RESPONSE_FD`

Both values must identify distinct, existing inherited pipe or socket descriptors above fd 2. The channel only reads from the request descriptor and only writes to the response descriptor; it does not infer those roles from OS-level descriptor mode flags because inherited runtime stdio descriptors may be bidirectional. Identical descriptors, regular files, absent or malformed values, and standard input/output/error are rejected so the channel cannot interfere with Pi's terminal or RPC streams.

The transport is one process-owned stream pair (Pi may re-run extension factories during session changes), bounded versioned JSONL and read-only. The channel, the session cwd, and the subagent source all live in one process-wide registry (`globalThis[Symbol.for("agentkit.inspection")]`) that survives module re-evaluation, because Pi loads every extension entry through a fresh jiti instance. Each request uses the current session cwd. Requests are `{v:1,id,op:"snapshot",area:"subagents"|"task"|"all"}`. It creates no files, sockets, listeners, or durable state. Child Pi processes never inherit these variables.
