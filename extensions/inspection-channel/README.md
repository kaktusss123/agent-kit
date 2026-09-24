# inherited inspection channel

Optional machine-facing read channel for a live agent-kit Pi process. It is inert unless Pi inherits valid pipe descriptors in both:

- `AGENTKIT_INSPECT_REQUEST_FD`
- `AGENTKIT_INSPECT_RESPONSE_FD`

The transport is bounded versioned JSONL and read-only. Requests are `{v:1,id,op:"snapshot",area:"subagents"|"task"|"all"}`. It creates no files, sockets, listeners, or durable state. Child Pi processes never inherit these variables.
