import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCodexCredential, type StoredCredentialReader } from "./auth.ts";

function jwt(claims: object): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
}

function fixture(tokens: Record<string, string | undefined>, stored: Record<string, { type: string; accountId?: unknown; access?: unknown }>) {
	const calls: string[] = [];
	return {
		calls,
		source: { async getApiKeyForProvider(provider: string) { calls.push(provider); return tokens[provider]; } },
		reader: ((provider: string) => stored[provider]) as StoredCredentialReader,
	};
}

const newToken = jwt({ per_user_salt: "synthetic-salt", encrypted_auth_metadata: "synthetic-encrypted-data" });
const newStored = { type: "oauth", access: newToken };
const legacyToken = jwt({ chatgpt_account_id: "legacy-account" });
const legacyStored = { type: "oauth", access: legacyToken, accountId: "legacy-account" };
const newCredential = { provider: "openai", token: newToken };
const legacyCredential = { provider: "openai-codex", token: legacyToken, account: "legacy-account" };

test("new encrypted OAuth needs no account identity and wins over legacy", async () => {
	const f = fixture({ openai: newToken, "openai-codex": legacyToken }, {
		openai: newStored, "openai-codex": legacyStored,
	});
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), newCredential);
	assert.deepEqual(f.calls, ["openai"]);
});

test("new opaque OAuth ignores irrelevant account metadata", async () => {
	const f = fixture({ openai: "opaque" }, { openai: { type: "oauth", access: "opaque", accountId: 123 } });
	assert.deepEqual(await resolveCodexCredential(f.source, f.reader), { provider: "openai", token: "opaque" });
});

for (const [name, record, resolved] of [
	["API key", { type: "api_key", access: "sk-key" }, "sk-key"],
	["API-key override", newStored, "sk-key"],
	["JWT-shaped override", newStored, jwt({ chatgpt_account_id: "wrong-account" })],
	["missing bearer", newStored, undefined],
	["missing credential", undefined, newToken],
] as const) {
	test(`${name} on new provider falls back to complete legacy pair`, async () => {
		const f = fixture({ openai: resolved, "openai-codex": legacyToken }, {
			...(record ? { openai: record } : {}), "openai-codex": legacyStored,
		});
		assert.deepEqual(await resolveCodexCredential(f.source, f.reader), legacyCredential);
	});
}

test("neither transport is safe without stored OAuth metadata", async () => {
	const f = fixture({ openai: newToken, "openai-codex": legacyToken }, {});
	await assert.rejects(resolveCodexCredential(f.source, null), { kind: "missing_auth" });
	assert.deepEqual(f.calls, []);
});

test("legacy account must match its own token and not the new provider", async () => {
	const f = fixture({ "openai-codex": "opaque-legacy" }, {
		openai: { ...newStored, accountId: "new-account" },
		"openai-codex": { type: "oauth", access: "opaque-legacy" },
	});
	await assert.rejects(resolveCodexCredential(f.source, f.reader), { kind: "missing_account_id" });
});

test("conflicting legacy JWT and stored identity are rejected", async () => {
	const f = fixture({ "openai-codex": legacyToken }, {
		"openai-codex": { ...legacyStored, accountId: "different-account" },
	});
	await assert.rejects(resolveCodexCredential(f.source, f.reader), { kind: "missing_account_id" });
});

test("legacy JWT claim cannot bypass stored OAuth access match", async () => {
	const f = fixture({ "openai-codex": legacyToken }, {
		"openai-codex": { ...legacyStored, access: "different-token" },
	});
	await assert.rejects(resolveCodexCredential(f.source, f.reader), { kind: "missing_auth" });
});

test("metadata is re-read after Pi refreshes the access token", async () => {
	const stored = { type: "oauth", access: "old-token" };
	const credential = await resolveCodexCredential({ async getApiKeyForProvider() {
		stored.access = newToken;
		return newToken;
	} }, provider => provider === "openai" ? stored : undefined);
	assert.deepEqual(credential, newCredential);
});
