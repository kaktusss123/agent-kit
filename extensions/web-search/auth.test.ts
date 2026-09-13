import { describe, expect, test } from "bun:test";
import { extractAccountIdFromToken, resolveCodexCredential, type CodexTokenSource, type StoredCredentialReader } from "./auth";

function tokenWithAccount(accountId: string | null): string {
	const auth: Record<string, unknown> = {};
	if (accountId !== null) auth.chatgpt_account_id = accountId;
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url");
	return `header.${payload}.signature`;
}

function tokenSource(token: string | undefined): CodexTokenSource {
	return {
		async getApiKeyForProvider(provider) {
			expect(provider).toBe("openai-codex");
			return token;
		},
	};
}

describe("resolveCodexCredential — missing auth", () => {
	test("missing /login openai-codex yields missing_auth pointing at /login", async () => {
		const error = await resolveCodexCredential(tokenSource(undefined), null).catch((e: unknown) => e);
		expect((error as { kind?: string }).kind).toBe("missing_auth");
		expect((error as Error).message).toContain("/login openai-codex");
	});
});

describe("resolveCodexCredential — account id resolution", () => {
	test("missing account id from both stored credential and token yields missing_account_id", async () => {
		const error = await resolveCodexCredential(tokenSource("opaque-token"), () => ({ type: "oauth", accountId: "  " })).catch(
			(e: unknown) => e,
		);
		expect((error as { kind?: string }).kind).toBe("missing_account_id");
		expect((error as Error).message).toContain("/login openai-codex");
	});

	test("prefers the stored OAuth credential account id", async () => {
		const reader: StoredCredentialReader = provider => {
			expect(provider).toBe("openai-codex");
			return { type: "oauth", accountId: "acct_stored" };
		};
		const credential = await resolveCodexCredential(tokenSource(tokenWithAccount("acct_token")), reader);
		expect(credential.account).toBe("acct_stored");
	});

	test("falls back to the token JWT claim when no stored credential is available", async () => {
		const credential = await resolveCodexCredential(tokenSource(tokenWithAccount("acct_token")), null);
		expect(credential.account).toBe("acct_token");
	});

	test("ignores non-oauth stored credentials", async () => {
		const credential = await resolveCodexCredential(tokenSource(tokenWithAccount("acct_token")), () => ({
			type: "api_key",
			accountId: "acct_bad",
		}));
		expect(credential.account).toBe("acct_token");
	});
});

describe("extractAccountIdFromToken", () => {
	test("extracts the ChatGPT account id claim", () => {
		expect(extractAccountIdFromToken(tokenWithAccount("acct_x"))).toBe("acct_x");
	});

	test("returns undefined for non-JWT tokens and tokens without the claim", () => {
		expect(extractAccountIdFromToken("not-a-jwt")).toBeUndefined();
		expect(extractAccountIdFromToken(tokenWithAccount(null))).toBeUndefined();
	});
});
