/**
 * Perf Stats — omp-style usage rows for pi.
 *
 * Under each assistant response: local timestamp, prompt→yield Δ, input
 * (cache writes folded in), output, cache-read tokens, TTFT and tok/s over
 * the full request duration. Under each tool call: execution time.
 *
 * pi's AssistantMessage carries no duration/ttft, so timing is measured here
 * from extension events. First content = any streamed block (thinking, text,
 * or tool call start) — matching what the provider actually produced first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type PerfRow, type TextUsageRow, type ToolUsageRow, formatToolRow, formatUsageRow } from "./format";

/** Streaming events that mark the first provider-produced content block. */
const FIRST_CONTENT_EVENTS = new Set([
	"thinking_start",
	"thinking_delta",
	"text_start",
	"text_delta",
	"toolcall_start",
]);

export default function (pi: ExtensionAPI) {
	let requestStart = 0;
	let firstContentAt = 0;
	/** Timestamp of the user prompt that started the current run (Δ anchor). */
	let turnStartedAt: number | undefined;
	const toolStarts = new Map<string, number>();

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			// First user message of a run anchors Δ; later ones (steering) don't
			// reset it, so multi-request runs keep the original prompt→yield span.
			turnStartedAt ??= event.message.timestamp;
		} else if (event.message.role === "assistant") {
			requestStart = Date.now();
			firstContentAt = 0;
		}
	});

	pi.on("message_update", async (event) => {
		if (firstContentAt > 0) return;
		if (FIRST_CONTENT_EVENTS.has(event.assistantMessageEvent.type)) {
			firstContentAt = Date.now();
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (requestStart === 0) return;

		const end = Date.now();
		const durationMs = Math.max(0, Math.round(end - requestStart));
		const ttftMs = firstContentAt > 0 ? firstContentAt - requestStart : undefined;
		const usage = event.message.usage;
		const turnElapsedMs = turnStartedAt !== undefined ? Math.max(0, end - turnStartedAt) : undefined;
		turnStartedAt = undefined;

		if (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || (ttftMs ?? 0) > 0) {
			const data: TextUsageRow = {
				kind: "text",
				timestamp: event.message.timestamp,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				ttftMs,
				durationMs,
				turnElapsedMs,
			};
			pi.appendEntry("perf-stats", data);
		}

		requestStart = 0;
		firstContentAt = 0;
	});

	pi.on("tool_execution_start", async (event) => {
		toolStarts.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", async (event) => {
		const start = toolStarts.get(event.toolCallId);
		toolStarts.delete(event.toolCallId);
		if (start === undefined) return;
		const data: ToolUsageRow = {
			kind: "tool",
			toolName: event.toolName,
			execTimeMs: Math.max(0, Date.now() - start),
		};
		pi.appendEntry("perf-stats", data);
	});

	pi.registerEntryRenderer<PerfRow>("perf-stats", (entry, _opts, theme) => {
		const data = entry.data;
		if (!data) return new Text("", 0, 0);
		const line = data.kind === "text" ? formatUsageRow(data) : formatToolRow(data);
		if (!line) return new Text("", 0, 0);
		return new Text(`  ${theme.fg("dim", line)}`, 0, 0);
	});
}
