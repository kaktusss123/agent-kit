/**
 * Pure formatting/measurement core for the perf-stats extension.
 *
 * Row layout and thresholds mirror oh-my-pi's usage rows:
 * timestamp · Δ turn time · input · output · cache read · TTFT · tok/s.
 * No pi imports here so `bun test` runs without the host.
 */

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
export const MIN_DURATION_MS = 100;

export interface TextUsageRow {
	kind: "text";
	/** Wall-clock time the response request started (ms since epoch). */
	timestamp: number;
	/** Non-cached prompt tokens billed as new input. */
	input: number;
	/** Total output tokens for the request. */
	output: number;
	/** Tokens read from the prompt cache. */
	cacheRead: number;
	/** Tokens written to the prompt cache. */
	cacheWrite: number;
	/** Request start → first content block, ms. Undefined when nothing streamed. */
	ttftMs?: number;
	/** Request start → stream end, ms. */
	durationMs: number;
	/** User prompt → response end wall time, ms. Undefined when no anchor. */
	turnElapsedMs?: number;
}

export interface ToolUsageRow {
	kind: "tool";
	toolName: string;
	execTimeMs: number;
}

export type PerfRow = TextUsageRow | ToolUsageRow;

/** Local `YYYY-MM-DD HH:mm:ss` stamp. */
export function formatUsageTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return `${date} ${time}`;
}

/** Compact duration: `450ms`, `12.3s`, `1m 5s`. Rounds away fractional ms. */
export function formatDuration(ms: number): string {
	const whole = Math.max(0, Math.round(ms));
	if (whole < 1000) return `${whole}ms`;
	if (whole < 60_000) return `${(whole / 1000).toFixed(1)}s`;
	const min = Math.floor(whole / 60_000);
	const sec = Math.round((whole % 60_000) / 1000);
	return `${min}m ${sec}s`;
}

/** Grouped token count, e.g. `12,345`. */
export function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * Output tokens per second over the FULL request duration — not the
 * post-TTFT window: reasoning tokens stream before the first visible byte,
 * so post-TTFT division inflates the rate. Undefined below the duration
 * floor or with zero output.
 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | undefined {
	if (durationMs <= MIN_DURATION_MS || outputTokens <= 0) return undefined;
	return (outputTokens / durationMs) * 1000;
}

/** Format the per-response usage row: segments joined with a double space. */
export function formatUsageRow(row: TextUsageRow): string {
	const parts: string[] = [];
	if (Number.isFinite(row.timestamp) && row.timestamp > 0) {
		parts.push(formatUsageTimestamp(row.timestamp));
	}
	if (row.turnElapsedMs !== undefined && row.turnElapsedMs > 0) {
		parts.push(`Δ ${formatDuration(row.turnElapsedMs)}`);
	}
	// Cache writes bill as prompt input, so they fold into the input figure.
	parts.push(`⤵ ${formatTokens(row.input + row.cacheWrite)}`);
	parts.push(`⤴ ${formatTokens(row.output)}`);
	if (row.cacheRead > 0) {
		parts.push(`💾 ${formatTokens(row.cacheRead)}`);
	}
	if (row.ttftMs !== undefined && row.ttftMs > 0) {
		parts.push(`⏱ ${(row.ttftMs / 1000).toFixed(1)}s`);
	}
	const tps = tokensPerSecond(row.output, row.durationMs);
	if (tps !== undefined) {
		parts.push(`⚡ ${tps.toFixed(1)}/s`);
	}
	return parts.join("  ");
}

/** Format the per-tool row: `bash: 1.2s`. */
export function formatToolRow(row: ToolUsageRow): string {
	return `${row.toolName}: ${formatDuration(row.execTimeMs)}`;
}
