# web-search

Hosted web search for pi over the **ChatGPT Codex backend**, using the
`/login openai` (Sign in with ChatGPT) or legacy `/login openai-codex`
OAuth credential pi already manages.

```
Pi agent -> web_search(query) -> pi openai / openai-codex OAuth
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

- Prefer `openai` only when `readStoredCredential("openai")` identifies an
  OAuth credential, not an API key. Otherwise try legacy `openai-codex`.
- Bearer token: `ModelRegistry.getApiKeyForProvider(provider)` — Pi remains
  the only refresh authority. Re-read the same provider's metadata afterwards.
- ChatGPT account id: the access token's `chatgpt_account_id` JWT claim, or
  that provider's stored `accountId` only when its stored `access` matches the
  resolved bearer. Conflicting identities on a matching token are rejected.
- Missing bearer, malformed/missing identity, or an API-key override makes a
  candidate unusable; try the complete legacy token/account pair instead.
  Never borrow identity from another provider. With no usable pair, fail before
  sending a request. Older Pi versions without `readStoredCredential` can use
  legacy JWT credentials, but cannot safely select new OpenAI credentials.

Run `/login openai` and choose **Sign in with ChatGPT**, or use legacy
`/login openai-codex`. Ordinary OpenAI API keys are not supported and are never
sent to this backend.

Pi 1.5.0's new OpenAI OAuth flow stores `access`, `refresh`, `expires`, `clientId`
and `scopes`, but does not guarantee a stored ChatGPT account id. Its native
transport targets `api.openai.com/v1`; this extension still uses only the
ChatGPT Codex backend. Tokens exposing only `encrypted_auth_metadata` do not
provide a recoverable account id; without a usable legacy credential they fail
with `missing_account_id`. A credential needs a usable ChatGPT identity, and the
backend must accept its grant; HTTP 401/403 remains an authentication failure,
not a reason to silently switch accounts or use paid API search.

## Model selection

- Session's active `openai` or `openai-codex` model ID is used unchanged when
  set. Pi 1.5.0 sends `model.id` unchanged in both transports; there is no
  provider-prefix stripping or invented model-name translation.
- Otherwise a short local fallback list is tried (`CONFIG.fallbackModels` in
  `index.ts`), advancing on `unsupported_model` and `no_web_search` errors only.

## Failure modes

`missing_auth`, `missing_account_id`, `auth` (401/403), `unsupported_model`,
`rate_limit`, `timeout` (120s bound), `network`, `no_web_search` (backend
answered without searching), `backend`. Auth failures point at
`/login openai` (Sign in with ChatGPT) and legacy `/login openai-codex`.
No cross-provider retry is performed after a backend authentication failure.

## Config

Constants at the top of `index.ts` (edit in place — no settings registry):
fallback model list, default `search_context_size` (`high`), timeout (120s).

## Tests

`node --test --test-timeout=180000 'extensions/web-search/*.test.ts'` from the
repository root — OAuth provider selection and isolation, API-key rejection,
real Pi extension loading/model selection/auth hints, mocked SSE streams
(success, missing search, HTTP/stream errors, cancellation, timeout), source
deduplication, compact model-facing output.

## Credits

SSE parsing and the credential-resolution approach are adapted from
[pi-codex-search](https://github.com/Leechael/pi-codex-search) (MIT License,
Copyright (c) 2025).
