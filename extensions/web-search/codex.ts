/**
 * ChatGPT Codex hosted web search over the Responses backend.
 *
 * One query in, one answer + source list out. The request goes to the official
 * ChatGPT Codex backend (`https://chatgpt.com/backend-api/codex/responses`)
 * using the OAuth bearer supplied by pi's `/login openai-codex` credential.
 *
 * Request shape follows the current backend contract (classic top-level hosted
 * tools; see oh-my-pi #7666 — Responses-Lite's `additional_tools` placement is
 * ignored for web_search by the backend, so the dedicated search keeps the
 * top-level contract): `tool_choice: { type: "web_search" }` forces the hosted
 * tool, `include: ["web_search_call.action.sources"]` recovers per-search
 * sources. A completion that never emitted `web_search_call` is rejected
 * rather than presented as a search result.
 *
 * SSE parsing adapted from pi-codex-search (https://github.com/Leechael/pi-codex-search),
 * MIT License, Copyright (c) 2025.
 */

import type { SearchContextSize } from "./format.ts";

// ============================================================================
// Errors
// ============================================================================

/**
 * Failure taxonomy surfaced to the model/user:
 * - `missing_auth` — no `/login openai-codex` credential in pi
 * - `missing_account_id` — credential carries no ChatGPT account id
 * - `auth` — backend rejected the credential (401/403)
 * - `unsupported_model` — the ChatGPT account cannot use the requested model
 * - `rate_limit` — 429 / quota
 * - `timeout` — bounded timeout fired
 * - `network` — connection-level failure
 * - `no_web_search` — backend answered without running the hosted search
 * - `backend` — anything else from the Codex backend
 */
export type WebSearchErrorKind =
	| "missing_auth"
	| "missing_account_id"
	| "auth"
	| "unsupported_model"
	| "rate_limit"
	| "timeout"
	| "network"
	| "no_web_search"
	| "backend";

export class WebSearchError extends Error {
	readonly kind: WebSearchErrorKind;
	readonly status?: number;

	constructor(kind: WebSearchErrorKind, message: string, status?: number) {
		super(message);
		this.name = "WebSearchError";
		this.kind = kind;
		if (status !== undefined) this.status = status;
	}
}

const UNSUPPORTED_MODEL_PATTERN =
	/model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i;
const RATE_LIMIT_PATTERN = /rate[- ]?limit|too many requests|quota|credits?\s*(?:exhausted|exceeded)|\b429\b/i;
const AUTH_PATTERN = /unauthori[sz]ed|\b401\b|forbidden|\b403\b|invalid[a-z]* token|expired/i;
const TIMEOUT_PATTERN = /timeout|timed out/i;

export function classifyHttpStatus(status: number, body: string): WebSearchErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limit";
	const detail = String(body);
	if (UNSUPPORTED_MODEL_PATTERN.test(detail)) return "unsupported_model";
	if (RATE_LIMIT_PATTERN.test(detail)) return "rate_limit";
	if (AUTH_PATTERN.test(detail)) return "auth";
	if (status >= 500 || status === 408) return "network";
	return "backend";
}

/**
 * Extracts a backend error `{code, message}` from a Codex SSE event, tolerating
 * the envelope shapes the ChatGPT Codex backend emits: top-level `{code,message}`,
 * a nested `error` object, and `response.error` (as in `response.failed`).
 */
function extractSseError(rawEvent: Record<string, unknown>): { code: string; message: string } {
	const candidates: unknown[] = [rawEvent, rawEvent.error, (rawEvent.response as { error?: unknown } | undefined)?.error];
	let code = "";
	let message = "";
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		if (!code && typeof record.code === "string" && record.code) code = record.code;
		if (!message && typeof record.message === "string" && record.message) message = record.message;
	}
	return { code, message };
}

function classifySseErrorMessage(message: string): WebSearchErrorKind {
	if (UNSUPPORTED_MODEL_PATTERN.test(message)) return "unsupported_model";
	if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (TIMEOUT_PATTERN.test(message)) return "timeout";
	if (AUTH_PATTERN.test(message)) return "auth";
	return "backend";
}

// ============================================================================
// Types
// ============================================================================

export interface SearchSource {
	url: string;
	title: string;
	snippet?: string;
}

export interface WebSearchResult {
	answer: string;
	sources: SearchSource[];
	/** Query strings the backend ran inside `web_search_call` actions. */
	searchQueries: string[];
	model: string;
	requestId?: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface RunWebSearchOptions {
	query: string;
	/** Codex model id to run the search with (resolved by the caller). */
	model: string;
	/** OAuth access token from pi's `/login openai-codex` credential. */
	token: string;
	/** ChatGPT account id (stored credential claim or JWT claim). */
	account: string;
	searchContextSize?: SearchContextSize;
	signal?: AbortSignal;
	/** Hard deadline for the whole search. Default 120s. */
	timeoutMs?: number;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

// ============================================================================
// Wire constants
// ============================================================================

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const DEFAULT_TIMEOUT_MS = 120_000;
const SEARCH_INSTRUCTIONS =
	"You are a concise web search assistant. Search the web to answer the user's question accurately and cite your sources.";

function userAgent(): string {
	// Matches the UA shape pi itself sends to this backend (originator "pi").
	return `pi (${process.platform} ${process.version}; ${process.arch}) web-search-extension`;
}

function buildHeaders(token: string, account: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", account);
	headers.set("originator", "pi");
	headers.set("User-Agent", userAgent());
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	// Region-pinned enterprise workspaces reject requests whose egress does not
	// match the token's residency unless the client declares it (oh-my-pi wire).
	const residency = jwtClaim(token, "chatgpt_data_residency") ?? jwtClaim(token, "chatgpt_compute_residency");
	if (residency) headers.set("x-openai-internal-codex-residency", residency);
	const requestId = crypto.randomUUID();
	headers.set("session-id", requestId);
	headers.set("x-client-request-id", requestId);
	return headers;
}

/** Decodes one string claim from the `https://api.openai.com/auth` JWT claim object. */
function jwtClaim(token: string, claim: string): string | undefined {
	const auth = decodeJwtAuthClaims(token);
	const value = auth?.[claim];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeJwtAuthClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
			[JWT_CLAIM_PATH]?: Record<string, unknown>;
		};
		const auth = payload[JWT_CLAIM_PATH];
		return auth && typeof auth === "object" ? auth : undefined;
	} catch {
		return undefined;
	}
}

function buildRequestBody(query: string, model: string, searchContextSize: SearchContextSize): Record<string, unknown> {
	return {
		model,
		stream: true,
		store: false,
		include: ["web_search_call.action.sources"],
		parallel_tool_calls: true,
		instructions: SEARCH_INSTRUCTIONS,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: searchContextSize,
			},
		],
		// Forced hosted choice: a search command must actually search. The
		// post-stream `web_search_call` guard below covers edge cases where the
		// backend ignores the forced choice.
		tool_choice: { type: "web_search" },
	};
}

// ============================================================================
// Timeout + cancellation
// ============================================================================

interface Deadline {
	signal: AbortSignal;
	/** True when the bounded timeout fired (as opposed to the external signal). */
	timedOut(): boolean;
	cleanup(): void;
}

function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new DOMException(`Web search timed out after ${timeoutMs}ms`, "TimeoutError"));
	}, timeoutMs);
	const onExternalAbort = () => {
		if (timedOut) return;
		controller.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
	};
	if (signal?.aborted) onExternalAbort();
	signal?.addEventListener("abort", onExternalAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onExternalAbort);
		},
	};
}

/** Maps an abort caught mid-search to the right failure kind. */
function classifyAbort(error: unknown, deadline: Deadline, external: AbortSignal | undefined): WebSearchError {
	if (external?.aborted) {
		const reason = external.reason;
		return new WebSearchError(
			"network",
			`Web search cancelled: ${reason instanceof Error ? reason.message : "aborted"}`,
		);
	}
	if (deadline.timedOut()) {
		return new WebSearchError("timeout", error instanceof Error ? error.message : "Web search timed out");
	}
	return new WebSearchError("network", error instanceof Error ? error.message : "Web search aborted");
}

// ============================================================================
// SSE parsing
// ============================================================================

interface SseEvent {
	type: string;
	data?: Record<string, unknown>;
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let doneReading = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				doneReading = true;
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const separator = /\r?\n\r?\n/.exec(buffer);
				if (!separator) break;
				const frame = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator[0].length);
				const event = parseSseFrame(frame);
				if (event) yield event;
			}
		}
	} finally {
		if (!doneReading) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	buffer += decoder.decode();
	const event = parseSseFrame(buffer);
	if (event) yield event;
}

function parseSseFrame(frame: string): SseEvent | undefined {
	const lines = frame.split(/\r?\n/);
	let type = "";
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("event:")) {
			type = line.slice("event:".length).trim();
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}
	if (dataLines.length === 0) return undefined;
	const raw = dataLines.join("\n");
	if (raw === "[DONE]") return undefined;
	try {
		const data = JSON.parse(raw) as Record<string, unknown>;
		return { type: typeof data.type === "string" && data.type ? data.type : type, data };
	} catch {
		return undefined;
	}
}

// ============================================================================
// Source collection
// ============================================================================

function normalizeSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		// Canonicalize case-insensitive parts and drop OpenAI attribution noise
		// so the same URL arriving via several channels deduplicates.
		url.hostname = url.hostname.toLowerCase();
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
		return url.toString();
	} catch {
		return rawUrl;
	}
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	const normalized: SearchSource = { ...source, url: normalizeSourceUrl(source.url) };
	// Keep url-titled sources aligned with their canonical URL so later merges
	// can upgrade the title from a richer channel (citations carry titles).
	if (normalized.title === source.url) normalized.title = normalized.url;
	const existing = sources.find(candidate => candidate.url === normalized.url);
	if (!existing) {
		sources.push(normalized);
		return;
	}
	if (existing.title === existing.url && normalized.title !== normalized.url) {
		existing.title = normalized.title;
	}
	if (!existing.snippet && normalized.snippet) existing.snippet = normalized.snippet;
}

function citationSnippet(text: string, start: number | undefined, end: number | undefined): string | undefined {
	if (start === undefined || end === undefined || !text || start < 0 || end <= start) return undefined;
	const snippet = text
		.slice(Math.max(0, start - 100), Math.min(text.length, end + 100))
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	if (!snippet) return undefined;
	return snippet.length > 240 ? `${snippet.slice(0, 237)}...` : snippet;
}

// Fallback scraping when the backend omits url_citation annotations and the
// include channel returned nothing: markdown links and bare URLs in the answer.
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];
	for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
		addSource(sources, { title: (match[1] ?? "").trim() || (match[2] as string), url: match[2] as string });
	}
	for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
		const raw = (match[0] ?? "").replace(/[.,;:!?'"]+$/, "");
		if (!raw) continue;
		addSource(sources, { title: raw, url: raw });
	}
	return sources;
}

// ============================================================================
// Event-stream walk
// ============================================================================

interface CodexSourceLike {
	url?: string;
	source_website_url?: string;
	title?: string;
	caption?: string;
}

interface CodexOutputItem {
	type?: string;
	id?: string;
	role?: string;
	status?: string;
	content?: Array<{
		type?: string;
		text?: string;
		annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }>;
	}>;
	action?: { query?: string; queries?: string[]; sources?: CodexSourceLike[] };
	sources?: CodexSourceLike[];
	results?: CodexSourceLike[];
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponseEnvelope {
	id?: string;
	model?: string;
	usage?: CodexUsage;
}

function collectSearchSources(item: CodexOutputItem, sources: SearchSource[]): void {
	for (const group of [item.action?.sources, item.sources, item.results]) {
		for (const source of group ?? []) {
			const url = source.url ?? source.source_website_url;
			if (!url) continue;
			addSource(sources, { title: source.title ?? source.caption ?? url, url });
		}
	}
}

async function consumeSearchStream(
	body: ReadableStream<Uint8Array>,
	requestedModel: string,
): Promise<WebSearchResult> {
	const answerParts: string[] = [];
	const streamedParts: string[] = [];
	const sources: SearchSource[] = [];
	const searchQueries: string[] = [];
	let model = requestedModel;
	let requestId: string | undefined;
	let usage: WebSearchResult["usage"];
	let webSearchInvoked = false;

	for await (const event of parseSse(body)) {
		const data = event.data;
		if (!data) continue;

		if (event.type === "response.created") {
			const response = data.response as CodexResponseEnvelope | undefined;
			if (response?.id) requestId = response.id;
			if (response?.model) model = response.model;
		} else if (event.type === "response.output_text.delta") {
			if (typeof data.delta === "string" && data.delta) streamedParts.push(data.delta);
		} else if (event.type === "response.output_item.done") {
			const item = data.item as CodexOutputItem | undefined;
			if (!item) continue;

			if (item.type === "web_search_call") {
				webSearchInvoked = true;
				const query = item.action?.query ?? item.action?.queries?.join(", ");
				if (query) searchQueries.push(query);
				collectSearchSources(item, sources);
			}

			if (item.type === "message" && item.role !== "user" && Array.isArray(item.content)) {
				for (const part of item.content) {
					if (part.type !== "output_text" || !part.text) continue;
					answerParts.push(part.text);
					for (const annotation of part.annotations ?? []) {
						if (annotation.type !== "url_citation" || !annotation.url) continue;
						addSource(sources, {
							title: annotation.title ?? annotation.url,
							url: annotation.url,
							snippet: citationSnippet(part.text, annotation.start_index, annotation.end_index),
						});
					}
				}
			}
		} else if (event.type === "response.completed" || event.type === "response.done") {
			const response = data.response as CodexResponseEnvelope | undefined;
			if (response?.model) model = response.model;
			if (response?.id) requestId = response.id;
			if (response?.usage) {
				const cached = response.usage.input_tokens_details?.cached_tokens ?? 0;
				usage = {
					inputTokens: (response.usage.input_tokens ?? 0) - cached,
					outputTokens: response.usage.output_tokens ?? 0,
					totalTokens: response.usage.total_tokens ?? 0,
				};
			}
		} else if (event.type === "error" || event.type === "response.failed") {
			const { code, message } = extractSseError(data);
			const detail = message || "Unknown Codex error";
			const kind = classifySseErrorMessage(detail);
			throw new WebSearchError(kind, code ? `Codex error (${code}): ${detail}` : `Codex error: ${detail}`);
		}
	}

	// A search command must never present a from-memory completion as a
	// search-backed result.
	if (!webSearchInvoked) {
		throw new WebSearchError(
			"no_web_search",
			"Codex returned an answer without running web search (no web_search_call event); refusing to treat it as a search result",
		);
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedParts.join("").trim();
	const answer = finalAnswer || streamedAnswer;
	if (!answer && sources.length === 0) {
		throw new WebSearchError("backend", "Codex web search returned no answer and no sources");
	}
	if (sources.length === 0 && answer) {
		for (const source of extractTextSources(answer)) addSource(sources, source);
	}
	return {
		answer,
		sources,
		searchQueries,
		model,
		...(requestId ? { requestId } : {}),
		...(usage ? { usage } : {}),
	};
}

// ============================================================================
// Entry point
// ============================================================================

export async function runWebSearch(options: RunWebSearchOptions): Promise<WebSearchResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = withDeadline(options.signal, timeoutMs);
	try {
		const fetchImpl = options.fetchImpl ?? fetch;
		let response: Response;
		try {
			response = await fetchImpl(CODEX_RESPONSES_URL, {
				method: "POST",
				headers: buildHeaders(options.token, options.account),
				body: JSON.stringify(
					buildRequestBody(options.query, options.model, options.searchContextSize ?? "high"),
				),
				signal: deadline.signal,
			});
		} catch (error) {
			throw classifyAbort(error, deadline, options.signal);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			const body = errorText.slice(0, 2000);
			throw new WebSearchError(
				classifyHttpStatus(response.status, body),
				`Codex API error (${response.status}): ${body || response.statusText}`,
				response.status,
			);
		}
		if (!response.body) {
			throw new WebSearchError("backend", "Codex API returned no response body");
		}

		try {
			return await consumeSearchStream(response.body, options.model);
		} catch (error) {
			if (error instanceof WebSearchError) throw error;
			if (deadline.signal.aborted) throw classifyAbort(error, deadline, options.signal);
			throw new WebSearchError(
				"backend",
				error instanceof Error ? error.message : "Codex web search stream failed",
			);
		}
	} finally {
		deadline.cleanup();
	}
}
