# inherited inspection channel

Optional machine-facing read channel for a live agent-kit Pi process. It is inert unless Pi inherits valid pipe descriptors in both:

- `AGENTKIT_INSPECT_REQUEST_FD`
- `AGENTKIT_INSPECT_RESPONSE_FD`

Both values must identify distinct inherited pipe descriptors above fd 2: the request descriptor must be open for reading and the response descriptor for writing. Invalid direction, identical descriptors, and standard input/output/error are rejected so the channel cannot interfere with Pi's terminal or RPC streams. On systems where descriptor direction cannot be verified, the channel stays inert.

The transport is one process-owned stream pair (Pi may re-run extension factories during session changes), bounded versioned JSONL and read-only. Each request uses the current session cwd. Requests are `{v:1,id,op:"snapshot",area:"subagents"|"task"|"all"}`. It creates no files, sockets, listeners, or durable state. Child Pi processes never inherit these variables.
