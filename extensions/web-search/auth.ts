/**
 * Codex credential resolution through pi's public APIs.
 *
 * The bearer token always comes from `ModelRegistry.getApiKeyForProvider` —
 * pi's single refresh authority for both `openai` and `openai-codex` OAuth.
 * This extension never stores, copies, or refreshes credentials itself.
 *
 * The ChatGPT account id comes from the resolved access token's JWT claim or
 * the matching provider's stored OAuth record via `readStoredCredential`
 * (resolved lazily for older hosts). New OpenAI grants need not expose it.
 *
 * Auth resolution approach adapted from pi-codex-search
 * (https://github.com/Leechael/pi-codex-search), MIT License, Copyright (c) 2025.
 */

import { WebSearchError } from "./codex.ts";

const OAUTH_PROVIDERS = ["openai", "openai-codex"] as const;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OAUTH_LOGIN_HINT =
	"Run `/login openai` and choose Sign in with ChatGPT, or use legacy `/login openai-codex`. OpenAI API keys cannot enable this search backend.";

/** Minimal surface of pi's ModelRegistry this extension depends on. */
export interface CodexTokenSource {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

interface StoredOAuthCredential {
	type?: unknown;
	accountId?: unknown;
	access?: unknown;
}

export type StoredCredentialReader = (providerId: string) => StoredOAuthCredential | undefined;

/**
 * Resolves `readStoredCredential` from the host pi installation. Returns null
 * outside pi (unit tests) or on older pi versions without the export.
 */
export async function loadStoredCredentialReader(): Promise<StoredCredentialReader | null> {
	try {
		const pi = (await import("@earendil-works/pi-coding-agent")) as {
			readStoredCredential?: StoredCredentialReader;
		};
		return pi.readStoredCredential ?? null;
	} catch {
		return null;
	}
}

/** Extracts the ChatGPT account id from a Codex access token JWT. */
export function extractAccountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
			[JWT_CLAIM_PATH]?: { chatgpt_account_id?: unknown };
		};
		const accountId = payload[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

export interface CodexCredential {
	token: string;
	account: string;
}

/**
 * Prefer new OpenAI OAuth when it carries a usable ChatGPT identity, otherwise
 * try legacy Codex. Never pair one provider's token with the other's account.
 * New OpenAI also supports API keys, so it requires an explicit OAuth record.
 * Older hosts without a reader can still use a legacy token's account claim.
 */
export async function resolveCodexCredential(
	tokenSource: CodexTokenSource,
	readStoredCredential: StoredCredentialReader | null,
): Promise<CodexCredential> {
	let missingAccount = false;
	for (const provider of OAUTH_PROVIDERS) {
		const before = readStoredCredential?.(provider);
		if (provider === "openai" && before?.type !== "oauth") continue;
		if (before && before.type !== "oauth") continue;

		// Only Pi resolves/refreshes the bearer. Re-read metadata after refresh.
		const token = await tokenSource.getApiKeyForProvider(provider);
		if (!token) continue;
		const stored = readStoredCredential?.(provider);
		if (stored && stored.type !== "oauth") continue;
		const fromToken = extractAccountIdFromToken(token);
		const storedAccount = stored?.type === "oauth" && typeof stored.accountId === "string"
			? stored.accountId.trim() : undefined;
		// A configured API key can override a stored OAuth record. Stored identity
		// is usable only for that exact access token, never for an unrelated key.
		const matchingStoredToken = stored?.type === "oauth" && stored.access === token;
		if (fromToken && (!matchingStoredToken || !storedAccount || fromToken === storedAccount)) {
			return { token, account: fromToken };
		}
		if (!fromToken && matchingStoredToken && storedAccount) return { token, account: storedAccount };
		missingAccount = true;
	}

	throw new WebSearchError(
		missingAccount ? "missing_account_id" : "missing_auth",
		`${missingAccount ? "No usable ChatGPT account id in the OAuth credentials." : "No usable ChatGPT OAuth credentials found."} ${OAUTH_LOGIN_HINT}`,
	);
}
