import { describe, expect, test } from "bun:test";
import { PerfTracker, STREAM_REPLAY_EPSILON_MS } from "./timing";

/** Fake clock: deterministic `now()`, advanced explicitly by the test. */
function makeTracker() {
	let now = 1_000_000;
	const tracker = new PerfTracker(() => now);
	return {
		tracker,
		advance: (ms: number) => {
			now += ms;
		},
		peek: () => now,
	};
}

const usage = { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 };

describe("request timing anchor", () => {
	test("TTFT and duration include the wait before message_start delivery", () => {
		// pi stamps message.timestamp inside the provider before dispatching the
		// HTTP request; message_start is only delivered once the stream opens.
		const { tracker, advance, peek } = makeTracker();
		const requestStart = peek();
		advance(800); // network + model queueing before response headers
		tracker.onAssistantStart(requestStart);
		advance(400); // stream open -> first thinking delta
		tracker.onStreamEvent("thinking_delta");
		advance(1500); // generation
		const row = tracker.onAssistantEnd(usage);

		expect(row?.durationMs).toBe(2700); // request dispatch -> end, not delivery -> end
		expect(row?.ttftMs).toBe(1200); // dispatch -> first content, including the 800ms wait
		expect(row?.timestamp).toBe(requestStart);
	});

	test("replayed stream (print mode) hides TTFT but keeps duration", () => {
		const { tracker, advance, peek } = makeTracker();
		const requestStart = peek();
		advance(3000); // whole response completed before events are delivered
		tracker.onAssistantStart(requestStart);
		advance(1); // buffered deltas replay in the same tick as message_start
		tracker.onStreamEvent("text_delta");
		advance(1);
		const row = tracker.onAssistantEnd(usage);

		expect(row?.durationMs).toBe(3002);
		expect(row?.ttftMs).toBeUndefined();
	});
});

describe("turn delta anchor", () => {
	test("Δ persists across tool-loop assistant messages within one run", () => {
		const { tracker, advance, peek } = makeTracker();
		tracker.onUserMessage(peek()); // user prompt at t
		const runStart = peek();

		advance(1000);
		tracker.onAssistantStart(peek());
		advance(500);
		const first = tracker.onAssistantEnd(usage); // assistant -> tools
		advance(200); // tool execution gap
		tracker.onAssistantStart(peek());
		advance(300);
		const second = tracker.onAssistantEnd(usage); // final response

		expect(first?.turnElapsedMs).toBe(1500);
		expect(second?.turnElapsedMs).toBe(peek() - runStart); // still anchored at the prompt
		expect(second?.turnElapsedMs).toBe(2000);
	});

	test("steering user message mid-run does not reset the anchor", () => {
		const { tracker, advance, peek } = makeTracker();
		tracker.onUserMessage(peek());
		const runStart = peek();

		advance(1000);
		tracker.onAssistantStart(peek());
		advance(500);
		tracker.onAssistantEnd(usage);

		advance(100);
		tracker.onUserMessage(peek()); // steering arrives mid-run
		advance(400);
		tracker.onAssistantStart(peek());
		advance(500);
		const row = tracker.onAssistantEnd(usage);

		expect(row?.turnElapsedMs).toBe(peek() - runStart); // anchored to the original prompt
	});

	test("agent_settled resets the anchor for the next run", () => {
		const { tracker, advance, peek } = makeTracker();
		tracker.onUserMessage(peek());
		advance(1000);
		tracker.onAssistantStart(peek());
		advance(500);
		expect(tracker.onAssistantEnd(usage)?.turnElapsedMs).toBe(1500);

		tracker.onAgentSettled();
		advance(60_000); // idle gap between runs
		tracker.onUserMessage(peek());
		advance(2000);
		tracker.onAssistantStart(peek());
		advance(500);
		expect(tracker.onAssistantEnd(usage)?.turnElapsedMs).toBe(2500); // new run, new anchor
	});
});

describe("row lifecycle", () => {
	test("unbilled usage with no TTFT yields no row", () => {
		const { tracker } = makeTracker();
		tracker.onAssistantStart(1_000_000);
		const row = tracker.onAssistantEnd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(row).toBeUndefined();
	});

	test("events before any assistant start are ignored", () => {
		const { tracker } = makeTracker();
		tracker.onStreamEvent("text_delta");
		expect(tracker.onAssistantEnd(usage)).toBeUndefined();
	});

	test("replay epsilon is below live first-token latency but above same-tick replay", () => {
		// Guard the constant: a same-tick replay (0-2ms) must be classified as
		// replayed, real streaming (>20ms between delivery and content) must not.
		expect(STREAM_REPLAY_EPSILON_MS).toBeGreaterThan(2);
		expect(STREAM_REPLAY_EPSILON_MS).toBeLessThan(20);
	});
});
