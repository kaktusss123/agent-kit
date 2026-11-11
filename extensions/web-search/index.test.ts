import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry).href);
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url")}.s`;
const newToken = jwt({ encrypted_auth_metadata: "synthetic-encrypted", per_user_salt: "synthetic-salt" });
const legacyToken = jwt({ chatgpt_account_id: "legacy-account" });
const legacy = { type: "oauth", access: legacyToken, accountId: "legacy-account" };
const success = [
	{ type: "response.output_item.done", item: { type: "web_search_call", action: { query: "latest release", sources: [{ url: "https://example.com/release", title: "Release" }] } } },
	{ type: "response.output_text.delta", delta: "Latest release [1]." },
	{ type: "response.completed", response: { id: "resp-test" } },
].map(data => `data: ${JSON.stringify(data)}\n\n`).join("");

test("real Pi tool routes OAuth transports, rejects API keys, and isolates providers", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "web-search-auth-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = scratch;
	try {
		const loaded = await loadExtensions([join(import.meta.dirname, "index.ts")], scratch);
		assert.deepEqual(loaded.errors, []);
		const tool = loaded.extensions[0].tools.get("web_search").definition;
		const cases = [
			{ name: "encrypted new OAuth without account identity", stored: { openai: { type: "oauth", access: newToken } }, tokens: { openai: newToken }, provider: "openai" },
			{ name: "new OAuth wins over legacy", stored: { openai: { type: "oauth", access: newToken, accountId: "ignored-account" }, "openai-codex": legacy }, tokens: { openai: newToken, "openai-codex": legacyToken }, provider: "openai" },
			{ name: "valid legacy", stored: { "openai-codex": legacy }, tokens: { "openai-codex": legacyToken }, provider: "openai-codex" },
			{ name: "API-key record falls back to legacy", stored: { openai: { type: "api_key", key: "sk-key" }, "openai-codex": legacy }, tokens: { openai: "sk-key", "openai-codex": legacyToken }, provider: "openai-codex" },
			{ name: "JWT-shaped override cannot bypass stored token match", stored: { openai: { type: "oauth", access: newToken }, "openai-codex": legacy }, tokens: { openai: jwt({ chatgpt_account_id: "override" }), "openai-codex": legacyToken }, provider: "openai-codex" },
			{ name: "ordinary new API key", stored: { openai: { type: "api_key", key: "sk-key" } }, tokens: { openai: "sk-key" } },
			{ name: "new API-key override", stored: { openai: { type: "oauth", access: newToken } }, tokens: { openai: "sk-key" } },
			{ name: "legacy API-key override", stored: { "openai-codex": legacy }, tokens: { "openai-codex": "sk-key" } },
			{ name: "legacy API-key record with JWT claim", stored: { "openai-codex": { type: "api_key", key: legacyToken } }, tokens: { "openai-codex": legacyToken } },
			{ name: "new token cannot borrow legacy record", stored: { "openai-codex": legacy }, tokens: { openai: newToken } },
			{ name: "legacy token cannot borrow new identity", stored: { openai: { type: "oauth", access: newToken, accountId: "wrong-account" }, "openai-codex": { type: "oauth", access: "opaque-legacy" } }, tokens: { "openai-codex": "opaque-legacy" } },
		];
		for (const c of cases) {
			writeFileSync(join(scratch, "auth.json"), JSON.stringify(c.stored));
			let requests = 0;
			globalThis.fetch = async (url, init) => {
				requests++;
				assert.ok(c.provider, `${c.name}: rejected credentials must never reach fetch`);
				const isNew = c.provider === "openai";
				assert.equal(String(url), isNew ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses", c.name);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), `Bearer ${isNew ? newToken : legacyToken}`, c.name);
				assert.equal(headers.get("chatgpt-account-id"), isNew ? null : "legacy-account", c.name);
				if (isNew) {
					assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization", "content-type"], c.name);
				} else {
					assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization", "chatgpt-account-id", "content-type", "openai-beta", "originator", "session-id", "user-agent", "x-client-request-id"], c.name);
					assert.equal(headers.get("originator"), "pi");
					assert.equal(headers.get("openai-beta"), "responses=experimental");
					assert.match(headers.get("user-agent") ?? "", /^pi \(.+\) web-search-extension$/);
					assert.match(headers.get("session-id") ?? "", /^[0-9a-f-]{36}$/);
					assert.equal(headers.get("session-id"), headers.get("x-client-request-id"));
				}
				assert.equal(headers.get("accept"), "text/event-stream");
				assert.equal(headers.get("content-type"), "application/json");
				const body = JSON.parse(String(init?.body));
				assert.equal(body.model, "gpt-6.1-terra", c.name);
				assert.deepEqual(body.tool_choice, { type: "web_search" });
				assert.deepEqual(body.include, ["web_search_call.action.sources"]);
				return new Response(success, { headers: { "content-type": "text/event-stream" } });
			};
			const result = await tool.execute("test", { query: "latest release" }, undefined, undefined, {
				model: { provider: c.provider ?? "openai", id: "gpt-6.1-terra" },
				modelRegistry: { async getApiKeyForProvider(id: string) { return (c.tokens as Record<string, string>)[id]; } },
			});
			assert.equal(requests, c.provider ? 1 : 0, `${c.name}: ${JSON.stringify(result.details)}`);
			if (c.provider) {
				assert.notEqual(result.isError, true, `${c.name}: ${JSON.stringify(result.details)}`);
				assert.equal(result.details.sources[0].url, "https://example.com/release");
			} else {
				assert.equal(result.isError, true, c.name);
				assert.match(result.details.error.kind, /^(missing_auth|missing_account_id)$/);
			}
		}
		writeFileSync(join(scratch, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: newToken } }));
		for (const status of [401, 403]) {
			globalThis.fetch = async () => new Response("denied", { status });
			const result = await tool.execute("test", { query: "latest release" }, undefined, undefined, {
				model: { provider: "openai", id: "gpt-6.1-terra" },
				modelRegistry: { async getApiKeyForProvider(id: string) { return id === "openai" ? newToken : undefined; } },
			});
			assert.equal(result.details.error.kind, "auth");
			assert.match(result.content[0].text, /\/login openai`/);
			assert.match(result.content[0].text, /\/login openai-codex/);
		}
	} finally {
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(scratch, { recursive: true, force: true });
	}
});
