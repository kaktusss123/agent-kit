# web-search

Hosted web search for pi over the **ChatGPT Codex backend**, using the
`/login openai-codex` OAuth credential pi already manages.

```
Pi agent -> web_search(query) -> pi openai-codex credential
          -> chatgpt.com/backend-api/codex/responses (hosted web_search tool)
          -> answer + source URLs -> Pi agent
```

## Tool

`web_search(query: string, search_context_size?: "low" | "medium" | "high")`

One call = one query. The backend request forces the hosted `web_search` tool
(`tool_choice: { type: "web_search" }`, `include: ["web_search_call.action.sources"]`);
a completion that never emitted a `web_search_call` event is rejected instead of
being returned as a search result. The model gets a compact synthesized answer
plus a numbered source list; the full result (answer, sources, backend search
queries, usage, request id) travels in tool-result `details` for the TUI.

## Auth

No token env vars, no own OAuth flow, no credential storage:

- bearer token: `ModelRegistry.getApiKeyForProvider("openai-codex")` — pi's
  refresh authority;
- ChatGPT account id: `readStoredCredential("openai-codex").accountId`, falling
  back to the `chatgpt_account_id` JWT claim of the access token.

Run `/login openai-codex` (ChatGPT Plus/Pro) if the credential is missing.

## Model selection

- Session's active `openai-codex` model is used directly when set.
- Otherwise a short local fallback list is tried (`CONFIG.fallbackModels` in
  `index.ts`), advancing on `unsupported_model` and `no_web_search` errors only.

## Failure modes

`missing_auth`, `missing_account_id`, `auth` (401/403), `unsupported_model`,
`rate_limit`, `timeout` (120s bound), `network`, `no_web_search` (backend
answered without searching), `backend`. Auth failures point at
`/login openai-codex`.

## Config

Constants at the top of `index.ts` (edit in place — no settings registry):
fallback model list, default `search_context_size` (`high`), timeout (120s).

## Tests

`node --test` — mocked SSE streams (success, missing search, HTTP/stream errors,
cancellation, timeout), source deduplication, compact model-facing output.

## Credits

SSE parsing and the credential-resolution approach are adapted from
[pi-codex-search](https://github.com/Leechael/pi-codex-search) (MIT License,
Copyright (c) 2025).
