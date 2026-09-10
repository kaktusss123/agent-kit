/**
 * Codex credential resolution through pi's public APIs.
 *
 * The bearer token always comes from `ModelRegistry.getApiKeyForProvider` —
 * pi's single refresh authority for the `/login openai-codex` credential.
 * This extension never stores, copies, or refreshes credentials itself.
 *
 * The ChatGPT account id is read from the stored OAuth credential via
 * `readStoredCredential` (public pi API, may lag the installed version —
 * resolved lazily), falling back to the `chatgpt_account_id` JWT claim of the
 * access token, which pi guarantees at login time.
 *
 * Auth resolution approach adapted from pi-codex-search
 * (https://github.com/Leechael/pi-codex-search), MIT License, Copyright (c) 2025.
 */

import { WebSearchError } from "./codex";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Minimal surface of pi's ModelRegistry this extension depends on. */
export interface CodexTokenSource {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

interface StoredOAuthCredential {
	type?: unknown;
	accountId?: unknown;
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
 * Resolves the Codex credential through pi. Throws:
 * - `missing_auth` when no `/login openai-codex` credential exists
 * - `missing_account_id` when neither the stored credential nor the token
 *   carries a ChatGPT account id
 */
export async function resolveCodexCredential(
	tokenSource: CodexTokenSource,
	readStoredCredential: StoredCredentialReader | null,
): Promise<CodexCredential> {
	const token = await tokenSource.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
	if (!token) {
		throw new WebSearchError(
			"missing_auth",
			"No OpenAI Codex credentials found. Run `/login openai-codex` (ChatGPT Plus/Pro) to enable web search.",
		);
	}

	const stored = readStoredCredential?.(OPENAI_CODEX_PROVIDER);
	if (stored && stored.type === "oauth" && typeof stored.accountId === "string" && stored.accountId.trim()) {
		return { token, account: stored.accountId.trim() };
	}

	const fromToken = extractAccountIdFromToken(token);
	if (fromToken) return { token, account: fromToken };

	throw new WebSearchError(
		"missing_account_id",
		"Codex credential carries no ChatGPT account id. Re-run `/login openai-codex` to refresh it.",
	);
}
