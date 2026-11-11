/**
 * OAuth search credential resolution through pi's public APIs.
 *
 * The bearer token always comes from `ModelRegistry.getApiKeyForProvider` —
 * pi's single refresh authority for both `openai` and `openai-codex` OAuth.
 * This extension never stores, copies, or refreshes credentials itself.
 *
 * Both transports require the resolved token to match the stored OAuth record.
 * Only legacy Codex needs a ChatGPT account id; new OpenAI grants need not
 * expose one. Pi remains the sole credential storage and refresh authority.
 *
 * Auth resolution approach adapted from pi-codex-search
 * (https://github.com/Leechael/pi-codex-search), MIT License, Copyright (c) 2025.
 */

import { WebSearchError, type SearchCredential } from "./codex.ts";

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

/**
 * Prefer new OpenAI OAuth, otherwise try legacy Codex. Never pair one
 * provider's token with the other's account or send a configured API key.
 * Without stored credential metadata neither transport can be used safely.
 */
export async function resolveCodexCredential(
	tokenSource: CodexTokenSource,
	readStoredCredential: StoredCredentialReader | null,
): Promise<SearchCredential> {
	let missingAccount = false;
	for (const provider of OAUTH_PROVIDERS) {
		const before = readStoredCredential?.(provider);
		if (before?.type !== "oauth") continue;

		// Only Pi resolves/refreshes the bearer. Re-read metadata after refresh.
		const token = await tokenSource.getApiKeyForProvider(provider);
		if (!token) continue;
		const stored = readStoredCredential?.(provider);
		// A runtime/configured API key can override a saved OAuth credential.
		// A JWT-shaped override is not proof of OAuth provenance either.
		if (stored?.type !== "oauth" || stored.access !== token) continue;
		if (provider === "openai") return { provider, token };
		const fromToken = extractAccountIdFromToken(token);
		const storedAccount = stored?.type === "oauth" && typeof stored.accountId === "string"
			? stored.accountId.trim() : undefined;
		if (fromToken && (!storedAccount || fromToken === storedAccount)) {
			return { provider, token, account: fromToken };
		}
		if (!fromToken && storedAccount) return { provider, token, account: storedAccount };
		missingAccount = true;
	}

	throw new WebSearchError(
		missingAccount ? "missing_account_id" : "missing_auth",
		`${missingAccount ? "No usable ChatGPT account id in the legacy Codex OAuth credential." : "No usable ChatGPT OAuth credentials found."} ${OAUTH_LOGIN_HINT}`,
	);
}
