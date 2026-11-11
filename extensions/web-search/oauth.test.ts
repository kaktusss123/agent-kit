import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCodexCredential, type StoredCredentialReader } from "./auth.ts";

function jwt(account: unknown): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}

function fixture(tokens: Record<string, string | undefined>, stored: Record<string, { type: string; accountId?: unknown; access?: unknown }>) {
	const calls: string[] = [];
	return {
		calls,
		source: { async getApiKeyForProvider(provider: string) { calls.push(provider); return tokens[provider]; } },
		reader: ((provider: string) => stored[provider]) as StoredCredentialReader,
	};
}

test("only new openai OAuth resolves its JWT account through Pi", async () => {
	const f = fixture({ openai: jwt("new-account") }, { openai: { type: "oauth" } });
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: jwt("new-account"), account: "new-account" });
	assert.deepEqual(f.calls, ["openai"]);
});

const legacyToken = jwt("legacy-account");
const legacyStored = { type: "oauth", access: legacyToken, accountId: "legacy-account" };

test("only legacy OAuth remains usable", async () => {
	const f = fixture({ "openai-codex": legacyToken }, { "openai-codex": legacyStored });
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: legacyToken, account: "legacy-account" });
	assert.deepEqual(f.calls, ["openai-codex"]);
});

test("both OAuth providers prefer new OpenAI without looking up legacy's bearer", async () => {
	const token = jwt("new-account");
	const f = fixture({ openai: token, "openai-codex": legacyToken }, {
		openai: { type: "oauth", access: token }, "openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token, account: "new-account" });
	assert.deepEqual(f.calls, ["openai"]);
});

const inapplicableCredentials: Array<{ type: string; access?: string; accountId?: unknown }> = [
	{ type: "api_key", accountId: "wrong-account" },
	{ type: "oauth", access: "opaque", accountId: " " },
	{ type: "oauth", access: "opaque", accountId: 123 },
	{ type: "oauth", access: "opaque" },
	{ type: "oauth", access: jwt("token-account"), accountId: "different-account" },
];
for (const [index, openai] of inapplicableCredentials.entries()) {
	test(`inapplicable new credential ${index + 1} falls back to complete legacy pair`, async () => {
		const f = fixture({ openai: openai.access ?? "sk-api-key", "openai-codex": legacyToken }, {
			openai, "openai-codex": legacyStored,
		});
		assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: legacyToken, account: "legacy-account" });
		if (openai.type === "api_key") assert.deepEqual(f.calls, ["openai-codex"]);
	});
}

test("API-key override cannot borrow stored OAuth identity", async () => {
	const f = fixture({ openai: "sk-runtime-key", "openai-codex": legacyToken }, {
		openai: { type: "oauth", access: "actual-oauth-token", accountId: "new-account" },
		"openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: legacyToken, account: "legacy-account" });
});

test("opaque OAuth token uses only its matching provider's stored identity", async () => {
	const f = fixture({ openai: "opaque-oauth" }, {
		openai: { type: "oauth", access: "opaque-oauth", accountId: " new-account " },
		"openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: "opaque-oauth", account: "new-account" });
});

test("encrypted new OAuth identity falls back without borrowing legacy account metadata", async () => {
	const token = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
		per_user_salt: "synthetic-salt", encrypted_auth_metadata: "synthetic-encrypted-data",
	} })).toString("base64url")}.s`;
	const f = fixture({ openai: token, "openai-codex": legacyToken }, {
		openai: { type: "oauth", access: token }, "openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: legacyToken, account: "legacy-account" });
});

test("new token cannot borrow legacy identity when both tokens lack one", async () => {
	const f = fixture({ openai: "opaque-new" }, {
		openai: { type: "oauth", access: "opaque-new" }, "openai-codex": legacyStored,
	});
	await assert.rejects(resolveCodexCredential(f.source, f.reader), { kind: "missing_account_id" });
});

test("missing new bearer falls back to legacy", async () => {
	const f = fixture({ "openai-codex": legacyToken }, {
		openai: { type: "oauth" }, "openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { token: legacyToken, account: "legacy-account" });
});

test("without credential metadata new API keys are never queried", async () => {
	const f = fixture({ openai: "sk-key", "openai-codex": legacyToken }, {});
	assert.deepEqual(await resolveCodexCredential(f.source, null), { token: legacyToken, account: "legacy-account" });
	assert.deepEqual(f.calls, ["openai-codex"]);
});

test("metadata is read after Pi refreshes the access token", async () => {
	const stored = { type: "oauth", access: "old-token", accountId: "old-account" };
	const credential = await resolveCodexCredential({ async getApiKeyForProvider() {
		stored.access = "new-token";
		stored.accountId = "new-account";
		return stored.access;
	} }, provider => provider === "openai" ? stored : undefined);
	assert.deepEqual(credential, { token: "new-token", account: "new-account" });
});
