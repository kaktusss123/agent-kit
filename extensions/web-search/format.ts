/**
 * Model-facing formatting: turn a {@link WebSearchResult} into the compact text
 * block the agent consumes. Raw SSE and response envelopes never reach this
 * layer; the full result travels in tool-result `details` for the TUI only.
 */

import type { SearchSource, WebSearchResult } from "./codex.ts";

export type SearchContextSize = "low" | "medium" | "high";

/** Source list budgets — enough breadth, bounded context cost. */
const MAX_MODEL_SOURCES = 20;
const MAX_TITLE_LENGTH = 120;

function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function sourceLine(index: number, source: SearchSource): string {
	const title = source.title && source.title !== source.url ? truncate(source.title, MAX_TITLE_LENGTH) : "";
	return title ? `[${index}] ${title}\n    ${source.url}` : `[${index}] ${source.url}`;
}

/** Compact result for the model: synthesized answer plus a numbered source list. */
export function formatForModel(result: WebSearchResult): string {
	const parts: string[] = [];
	if (result.answer) {
		parts.push(result.answer);
	} else {
		parts.push("(Codex returned sources without an answer text)");
	}

	if (result.sources.length > 0) {
		parts.push("\nSources:");
		const shown = result.sources.slice(0, MAX_MODEL_SOURCES);
		shown.forEach((source, i) => parts.push(sourceLine(i + 1, source)));
		if (result.sources.length > shown.length) {
			parts.push(`(+${result.sources.length - shown.length} more sources omitted)`);
		}
	}

	return parts.join("\n");
}

/** Compact one-line error text for the model; never leaks raw response bodies. */
export function formatErrorForModel(kind: string, message: string): string {
	return `Web search failed (${kind}): ${message}`;
}
