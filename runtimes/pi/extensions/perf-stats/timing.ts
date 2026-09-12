/**
 * Timing state machine for the perf-stats extension.
 *
 * Time is injected (`now`), so event-wiring regressions are testable without
 * stubbing global clocks. Grounded in pi 0.85.1 lifecycle facts:
 *
 * - `AssistantMessage.timestamp` is stamped inside the provider stream
 *   function when the output message is constructed, BEFORE the HTTP request
 *   is dispatched (e.g. `api/anthropic-messages.js`: `timestamp: Date.now()`,
 *   then `client.beta.messages.create(...)`, then `stream.push("start")`).
 *   The extension `message_start` event only fires on that first `start`
 *   event — after the response headers arrived. Anchoring at the message
 *   timestamp therefore includes the network/model wait that a
 *   `Date.now()`-at-`message_start` anchor loses.
 * - `agent_settled` is emitted by AgentSession in a `finally` around the
 *   whole agent run (success, errors, aborts, after retries/continuations),
 *   making it the safe reset boundary for the Δ anchor.
 * - In print mode pi replays buffered stream events at message end; first
 *   content then arrives within the same tick as `message_start` delivery.
 *   TTFT is unrecoverable there and is reported as undefined instead of
 *   surfacing a duration-shaped fake value.
 */

import type { TextUsageRow } from "./format";

/** Streaming events that mark the first provider-produced content block. */
export const FIRST_CONTENT_EVENTS = new Set([
	"thinking_start",
	"thinking_delta",
	"text_start",
	"text_delta",
	"toolcall_start",
]);

/**
 * If the first content event lands this soon after `message_start` delivery,
 * the stream was replayed from a buffer (print mode), not streamed live.
 */
export const STREAM_REPLAY_EPSILON_MS = 5;


export class PerfTracker {
	#now: () => number;
	/** Provider request start (message timestamp); 0 = no request in flight. */
	#requestStart = 0;
	/** Wall time at which the `message_start` handler actually ran. */
	#startDeliveredAt = 0;
	#firstContentAt = 0;
	/** User prompt anchoring Δ; undefined until the next run anchors it. */
	#turnStartedAt: number | undefined;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** First user prompt of a run anchors Δ; mid-run steering/follow-ups are ignored. */
	onUserMessage(timestamp: number): void {
		if (!(timestamp > 0)) return;
		this.#turnStartedAt ??= timestamp;
	}

	/** End of the whole agent run — drop the Δ anchor. */
	onAgentSettled(): void {
		this.#turnStartedAt = undefined;
	}

	onAssistantStart(timestamp: number): void {
		this.#requestStart = timestamp > 0 ? timestamp : this.#now();
		this.#startDeliveredAt = this.#now();
		this.#firstContentAt = 0;
	}

	onStreamEvent(type: string): void {
		if (this.#requestStart === 0 || this.#firstContentAt > 0) return;
		if (FIRST_CONTENT_EVENTS.has(type)) this.#firstContentAt = this.#now();
	}

	onAssistantEnd(usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	}): TextUsageRow | undefined {
		if (this.#requestStart === 0) return undefined;
		const requestStart = this.#requestStart;
		const end = this.#now();
		const durationMs = Math.max(0, Math.round(end - this.#requestStart));
		let ttftMs: number | undefined;
		if (
			this.#firstContentAt > 0 &&
			this.#firstContentAt - this.#startDeliveredAt >= STREAM_REPLAY_EPSILON_MS
		) {
			ttftMs = Math.max(0, this.#firstContentAt - this.#requestStart);
		}
		const turnElapsedMs =
			this.#turnStartedAt !== undefined ? Math.max(0, Math.round(end - this.#turnStartedAt)) : undefined;

		this.#requestStart = 0;
		this.#startDeliveredAt = 0;
		this.#firstContentAt = 0;

		const billed =
			usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || (ttftMs ?? 0) > 0;
		if (!billed) return undefined;
		return {
			kind: "text",
			timestamp: requestStart,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			ttftMs,
			durationMs,
			turnElapsedMs,
		};
	}
}
