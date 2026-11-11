import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry).href);

test("real Pi tool uses the active openai model ID unchanged and reports OAuth login on HTTP auth failures", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "web-search-auth-"));
	const previousDir = process.env.PI_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_AGENT_DIR = scratch;
	const token = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "new-account" } })).toString("base64url")}.s`;
	writeFileSync(join(scratch, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: token } }));
	try {
		const loaded = await loadExtensions([join(import.meta.dirname, "index.ts")], scratch);
		assert.deepEqual(loaded.errors, []);
		const tool = loaded.extensions[0].tools.get("web_search").definition;
		for (const [provider, expectedModel, status] of [
			["openai", "gpt-6.1-terra", 401],
			["openai-codex", "gpt-6.1-terra", 403],
			["anthropic", "gpt-5.6-luna", 401],
		] as const) {
			let body: { model?: string } = {};
			let headers = new Headers();
			let requests = 0;
			globalThis.fetch = async (_url, init) => {
				requests++;
				body = JSON.parse(String(init?.body));
				headers = new Headers(init?.headers);
				return new Response("denied", { status });
			};
			const result = await tool.execute("test", { query: "latest release" }, undefined, undefined, {
				model: { provider, id: "gpt-6.1-terra" },
				modelRegistry: { async getApiKeyForProvider(id: string) { return id === "openai" ? token : undefined; } },
			});
			assert.equal(body.model, expectedModel);
			assert.equal(headers.get("chatgpt-account-id"), "new-account");
			assert.equal(headers.get("authorization"), `Bearer ${token}`);
			assert.equal(requests, 1);
			assert.equal(result.isError, true);
			assert.equal(result.details.error.kind, "auth");
			assert.match(result.content[0].text, /\/login openai`/);
			assert.match(result.content[0].text, /\/login openai-codex/);
		}

		writeFileSync(join(scratch, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-synthetic-key" } }));
		globalThis.fetch = async () => { assert.fail("API keys must not reach ChatGPT"); };
		const result = await tool.execute("test", { query: "latest release" }, undefined, undefined, {
			modelRegistry: { async getApiKeyForProvider(provider: string) { return provider === "openai" ? "sk-synthetic-key" : undefined; } },
		});
		assert.equal(result.isError, true);
		assert.match(result.details.error.kind, /^(missing_auth|missing_account_id)$/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousDir;
		rmSync(scratch, { recursive: true, force: true });
	}
});
