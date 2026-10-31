/**
 * Perf Stats — omp-style usage rows for pi.
 *
 * Under each assistant response: local timestamp (provider request start),
 * prompt→yield Δ across the whole agent run, input (cache writes folded in),
 * output, cache-read tokens, TTFT and tok/s over the full request duration.
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
import { type TextUsageRow, formatUsageRow } from "./format.ts";
import { PerfTracker } from "./timing.ts";

export default function (pi: ExtensionAPI) {
	const tracker = new PerfTracker();
	/** Row computed at message_end, flushed at turn_end — see the handler below. */
	let pendingRow: TextUsageRow | undefined;

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
		pendingRow = tracker.onAssistantEnd(event.message.usage);
	});

	// The row must be appended at turn_end, not message_end: pi delivers
	// message_end to extensions BEFORE the TUI listener clears its streaming
	// component, and entries appended that early are spliced in front of the
	// message they describe (interactive-mode addCustomEntryToChat). turn_end
	// fires after the message and its tool results are settled, so the row
	// lands below the response — including the final one.
	pi.on("turn_end", async () => {
		if (!pendingRow) return;
		const row = pendingRow;
		pendingRow = undefined;
		pi.appendEntry("perf-stats", row);
	});

	pi.on("agent_settled", async () => {
		tracker.onAgentSettled();
	});

	pi.registerEntryRenderer<TextUsageRow>("perf-stats", (entry, _opts, theme) => {
		const data = entry.data;
		if (!data) return new Text("", 0, 0);
		const line = formatUsageRow(data);
		if (!line) return new Text("", 0, 0);
		return new Text(`  ${theme.fg("dim", line)}`, 0, 0);
	});
}
