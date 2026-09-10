/**
 * Perf Stats — omp-style usage rows for pi.
 *
 * Under each assistant response: local timestamp (provider request start),
 * prompt→yield Δ across the whole agent run, input (cache writes folded in),
 * output, cache-read tokens, TTFT and tok/s over the full request duration.
 * Under each tool call: execution time.
 *
 * pi's AssistantMessage carries no duration/ttft, so timing lives in
 * `timing.ts` (PerfTracker) and is fed from extension events:
 * - request start = `message.timestamp` (stamped by the provider before the
 *   HTTP request; `message_start` delivery alone would miss the wait for
 *   response headers),
 * - first content = any streamed block (thinking/text/toolcall start or
 *   delta) after `message_start` delivery,
 * - run end (Δ reset) = `agent_settled`, which pi emits in a finally block
 *   covering success, errors, and aborts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type PerfRow, type ToolUsageRow, formatToolRow, formatUsageRow } from "./format";
import { PerfTracker } from "./timing";

export default function (pi: ExtensionAPI) {
	const tracker = new PerfTracker();

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			tracker.onUserMessage(event.message.timestamp);
		} else if (event.message.role === "assistant") {
			tracker.onAssistantStart(event.message.timestamp);
		}
	});

	pi.on("message_update", async (event) => {
		tracker.onStreamEvent(event.assistantMessageEvent.type);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const row = tracker.onAssistantEnd(event.message.usage);
		if (row) pi.appendEntry("perf-stats", row);
	});

	pi.on("tool_execution_start", async (event) => {
		tracker.onToolStart(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event) => {
		const row = tracker.onToolEnd(event.toolCallId, event.toolName);
		if (row) pi.appendEntry("perf-stats", row);
	});

	pi.on("agent_settled", async () => {
		tracker.onAgentSettled();
	});

	pi.registerEntryRenderer<PerfRow>("perf-stats", (entry, _opts, theme) => {
		const data = entry.data;
		if (!data) return new Text("", 0, 0);
		const line = data.kind === "text" ? formatUsageRow(data) : formatToolRow(data);
		if (!line) return new Text("", 0, 0);
		return new Text(`  ${theme.fg("dim", line)}`, 0, 0);
	});
}
