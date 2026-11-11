# web-search

Hosted web search using the `/login openai` (Sign in with ChatGPT) or legacy
`/login openai-codex` OAuth credential pi already manages.

```
Pi agent -> web_search(query) -> pi-managed OAuth
          -> openai:       api.openai.com/v1/responses
          -> openai-codex: chatgpt.com/backend-api/codex/responses
          -> hosted web_search -> answer + source URLs -> Pi agent
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

- Prefer `openai` OAuth. If absent or inapplicable, try legacy `openai-codex`.
- Bearer token: `ModelRegistry.getApiKeyForProvider(provider)` — Pi remains
  the only refresh authority. Re-read the same provider's metadata afterwards.
- Both transports require `readStoredCredential(provider).type === "oauth"`
  and exact equality between its stored `access` and the resolved bearer.
  Configured API-key overrides are rejected, even if JWT-shaped. Hosts without
  `readStoredCredential` fail closed for both transports.
- New `openai` OAuth uses `https://api.openai.com/v1/responses` with Bearer
  authorization and no `chatgpt-account-id` or legacy Codex headers. It does
  not need an account id: JWTs exposing only `encrypted_auth_metadata` and
  `per_user_salt` are supported.
- Legacy `openai-codex` uses `https://chatgpt.com/backend-api/codex/responses`
  with its own ChatGPT account id from the token's `chatgpt_account_id` JWT
  claim or the matching provider's stored `accountId`. Conflicting identities
  are rejected. Never borrow another provider's token or account metadata.
- Missing bearer, mismatched stored access, or an API-key record makes a
  credential unusable; a missing account id does so only for legacy Codex.
  With no usable OAuth credential, fail before sending a request.

Run `/login openai` and choose **Sign in with ChatGPT**, or use legacy
`/login openai-codex`. Ordinary OpenAI API keys are not supported and are never
sent to either endpoint. The native OpenAI endpoint is used only for the new
ChatGPT OAuth transport, not as an ordinary paid API-key search backend.
HTTP 401/403 remains an authentication failure, not a reason to silently
switch accounts or use paid API search.

## Model selection

- Session's active `openai` or `openai-codex` model ID is used unchanged when
  set. Pi 1.5.0 sends `model.id` unchanged in both transports; there is no
  provider-prefix stripping or invented model-name translation.
- Otherwise a short local fallback list is tried (`CONFIG.fallbackModels` in
  `index.ts`), advancing on `unsupported_model` and `no_web_search` errors only.

## Failure modes

`missing_auth`, `missing_account_id` (legacy only), `auth` (401/403), `unsupported_model`,
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

### Live verification

With existing Pi OAuth and the project-local Pi dependencies, run:

```sh
timeout 105s node extensions/web-search/live/probe.ts [model-id]
```

The default model is `gpt-6.1-terra`. This calls the actual credential resolver
and search transport using public Pi authentication APIs. It requires a hosted
`web_search_call`, a completion event, a non-empty answer, and usable source
URLs. It prints only provider, endpoint, model, event checks, answer length,
and source URLs — never tokens or credential contents. The probe is bounded
at 90 seconds and does not change host configuration or installation; Pi alone
may refresh its OAuth credential. No server or background process is started.
It is not part of the offline test suite and requires network access and a
working ChatGPT OAuth grant. Legacy transport is covered offline; a live
legacy check additionally requires an applicable stored legacy credential.

## Credits

SSE parsing and the credential-resolution approach are adapted from
[pi-codex-search](https://github.com/Leechael/pi-codex-search) (MIT License,
Copyright (c) 2025).
