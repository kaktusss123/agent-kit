/**
 * web_search — hosted web search over the ChatGPT Codex backend, wired to pi's
 * existing `/login openai-codex` OAuth credential.
 *
 * Flow: `web_search(query)` → Codex Responses (`/codex/responses`) with the
 * hosted `web_search` tool forced → synthesized answer + source URLs/citations
 * → compact model-facing text, full result in `details`.
 *
 * Minimal subset of oh-my-pi's web-search subsystem: single provider (Codex),
 * single query per call, no provider registry/fallback chain, no query-syntax
 * parser, no settings subsystem. Auth goes through pi's ModelRegistry — no
 * token env vars, no own OAuth flow, no credential storage.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadStoredCredentialReader, resolveCodexCredential } from "./auth";
import { runWebSearch, WebSearchError, type SearchSource, type WebSearchResult } from "./codex";
import { formatErrorForModel, formatForModel, type SearchContextSize } from "./format";

// =============================================================================
// Configuration (edit here — no settings registry by design)
// =============================================================================

const CONFIG = {
	/**
	 * Model candidates used when the session's active model is not an
	 * openai-codex model. Tried in order; advances on `unsupported_model`
	 * (account lacks the SKU) and `no_web_search` (model answered without
	 * searching). Keep this list short and account-safe.
	 */
	fallbackModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
	/** Default search depth when the model does not ask for one. */
	defaultSearchContextSize: "high" as SearchContextSize,
	/** Hard deadline for one search, in milliseconds. */
	timeoutMs: 120_000,
};

// =============================================================================
// Tool schema
// =============================================================================

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"Search query. One query per call; issue multiple calls for independent questions. Supports web-search operators like site: and quoted phrases.",
	}),
	search_context_size: Type.Optional(
		StringEnum(["low", "medium", "high"] as const, {
			description: "How much web context to retrieve. Defaults to high.",
		}),
	),
});

interface WebSearchArgs {
	query?: string;
	search_context_size?: SearchContextSize;
}

const TOOL_DESCRIPTION = `Web search: current information from the web beyond your knowledge cutoff, via the ChatGPT Codex backend with its hosted web_search tool.

- SHOULD prefer primary sources (official docs, papers, release notes); corroborate key claims across sources.
- MUST cite the returned source URLs in your final response when you use their content.
- NEVER use for a known URL (GitHub repo, docs page, arXiv paper) — fetch it directly instead.
- One call = one query. Use several calls for independent questions; do not batch.
- The result contains a synthesized answer plus numbered sources; treat answer claims without a source as unverified.
- Fails deliberately if the backend answered without actually running web search.`;

// =============================================================================
// Details (TUI) + renderers
// =============================================================================

interface WebSearchDetails {
	query: string;
	searchContextSize: SearchContextSize;
	elapsedMs: number;
	model?: string;
	requestId?: string;
	answer?: string;
	sources?: SearchSource[];
	searchQueries?: string[];
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
	error?: { kind: string; message: string };
}

function forDisplay(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: string, maxLength = 110): string {
	const line = text
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 0);
	return line ? truncateToWidth(forDisplay(line), maxLength) : "";
}

function renderCall(args: WebSearchArgs, theme: Theme): Component {
	const query = truncateToWidth(forDisplay(args.query ?? ""), 90);
	const suffix = args.search_context_size ? theme.fg("dim", ` [${args.search_context_size}]`) : "";
	return new Text(`${theme.fg("accent", "● web_search(")}${query}${theme.fg("accent", ")")}${suffix}`, 0, 0);
}

function renderResult(result: { details?: WebSearchDetails; isError?: boolean }, expanded: boolean, theme: Theme): Component {
	const details = result.details;
	if (!details) {
		const fallback = result.isError ? "web_search failed" : "web_search finished";
		return new Text(theme.fg(result.isError ? "error" : "success", `✓ ${fallback}`), 0, 0);
	}

	if (details.error) {
		const header = theme.fg("warning", `✗ web_search failed (${details.error.kind})`);
		const message = theme.fg("dim", truncateToWidth(forDisplay(details.error.message), 160));
		return new Text(`${header}\n${message}`, 0, 0);
	}

	const seconds = details.elapsedMs >= 1000 ? ` in ${Math.max(1, Math.round(details.elapsedMs / 1000))}s` : ` in ${details.elapsedMs}ms`;
	const sourceCount = details.sources?.length ?? 0;
	const header =
		theme.fg("success", `✓ web_search`) +
		theme.fg("dim", ` · ${sourceCount} source${sourceCount === 1 ? "" : "s"}${seconds} · ${details.model ?? "codex"}`);

	if (!expanded) {
		const preview = firstLine(details.answer ?? "");
		return new Text(preview ? `${header}\n${theme.fg("dim", preview)}` : header, 0, 0);
	}

	const lines: string[] = [header];
	if (details.searchQueries && details.searchQueries.length > 0 && details.searchQueries[0] !== details.query) {
		lines.push(theme.fg("muted", `Query: ${truncateToWidth(forDisplay(details.searchQueries[0] ?? ""), 140)}`));
	}
	if (details.answer) {
		lines.push("");
		for (const line of details.answer.split("\n")) lines.push(theme.fg("toolOutput", line));
	}
	if (details.sources && details.sources.length > 0) {
		lines.push("");
		lines.push(theme.fg("muted", "Sources:"));
		for (const [i, source] of details.sources.entries()) {
			const title = source.title && source.title !== source.url ? ` ${truncateToWidth(forDisplay(source.title), 90)}` : "";
			lines.push(`  ${theme.fg("accent", `[${i + 1}]`)}${title}`);
			lines.push(`      ${theme.fg("dim", source.url)}`);
		}
	}
	return new Text(lines.join("\n"), 0, 0);
}

// =============================================================================
// Search execution (model selection + error mapping)
// =============================================================================

interface ModelResolution {
	candidates: string[];
	/** True when the first candidate is the session's explicit active model. */
	fromActiveModel: boolean;
}

function resolveModelCandidates(activeModelId: string | undefined, activeProvider: string | undefined): ModelResolution {
	if (activeModelId && activeProvider === "openai-codex") {
		return { candidates: [activeModelId], fromActiveModel: true };
	}
	return { candidates: [...CONFIG.fallbackModels], fromActiveModel: false };
}

/** Errors that justify trying the next default candidate. */
function shouldAdvanceCandidate(error: WebSearchError, fromActiveModel: boolean): boolean {
	if (fromActiveModel) return false;
	return error.kind === "unsupported_model" || error.kind === "no_web_search";
}

function errorResult(params: WebSearchArgs, error: WebSearchError, elapsedMs: number) {
	const details: WebSearchDetails = {
		query: params.query ?? "",
		searchContextSize: params.search_context_size ?? CONFIG.defaultSearchContextSize,
		elapsedMs,
		error: { kind: error.kind, message: error.message },
	};
	return {
		content: [{ type: "text" as const, text: formatErrorForModel(error.kind, error.message) }],
		details,
		isError: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Search the web via the ChatGPT Codex subscription; returns an answer with source URLs",
		parameters: WebSearchParams,

		async execute(_toolCallId, params: WebSearchArgs, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const query = params.query?.trim();
			if (!query) {
				return errorResult(
					params,
					new WebSearchError("backend", "A non-empty query is required"),
					Date.now() - startedAt,
				);
			}

			const searchContextSize = params.search_context_size ?? CONFIG.defaultSearchContextSize;

			// Credential: pi's stored /login openai-codex OAuth, refreshed by pi.
			let token: string;
			let account: string;
			try {
				const credential = await resolveCodexCredential(
					ctx.modelRegistry,
					await loadStoredCredentialReader(),
				);
				token = credential.token;
				account = credential.account;
			} catch (error) {
				return errorResult(
					params,
					error instanceof WebSearchError ? error : new WebSearchError("backend", String(error)),
					Date.now() - startedAt,
				);
			}

			const { candidates, fromActiveModel } = resolveModelCandidates(ctx.model?.id, ctx.model?.provider);
			let lastError: WebSearchError | undefined;
			for (const [index, model] of candidates.entries()) {
				try {
					const result = await runWebSearch({
						query,
						model,
						token,
						account,
						searchContextSize,
						signal,
						timeoutMs: CONFIG.timeoutMs,
					});
					const details: WebSearchDetails = {
						query,
						searchContextSize,
						elapsedMs: Date.now() - startedAt,
						model: result.model,
						...(result.requestId ? { requestId: result.requestId } : {}),
						answer: result.answer,
						sources: result.sources,
						searchQueries: result.searchQueries,
						...(result.usage ? { usage: result.usage } : {}),
					};
					return {
						content: [{ type: "text" as const, text: formatForModel(result) }],
						details,
					};
				} catch (error) {
					const searchError =
						error instanceof WebSearchError
							? error
							: new WebSearchError("backend", error instanceof Error ? error.message : String(error));
					lastError = searchError;
					if (index === candidates.length - 1 || !shouldAdvanceCandidate(searchError, fromActiveModel)) break;
				}
			}

			return errorResult(params, lastError ?? new WebSearchError("backend", "Web search failed"), Date.now() - startedAt);
		},

		renderCall(args, theme) {
			return renderCall(args as WebSearchArgs, theme);
		},

		renderResult(result, options, theme) {
			return renderResult(
				result as { details?: WebSearchDetails; isError?: boolean },
				options.expanded,
				theme,
			);
		},
	});
}

export type { WebSearchResult, SearchSource };
