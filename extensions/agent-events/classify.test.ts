import { describe, expect, test } from "bun:test";
import { classifyRunOutcome, truncateCodePoints } from "./classify";

function assistant(overrides: Partial<{ stopReason: string; errorMessage: string; text: string }> = {}) {
	return {
		role: "assistant",
		content: overrides.text ? [{ type: "text", text: overrides.text }] : [],
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
	};
}

describe("classifyRunOutcome", () => {
	test("classifies a normal stop as completed with joined text", () => {
		const outcome = classifyRunOutcome([
			{ role: "user", content: "hi" },
			assistant({ text: "part one" }),
			assistant({ text: "part two" }),
		]);
		expect(outcome).toEqual({ status: "completed", response: "part two" });
	});

	test("classifies stopReason error as failed with errorMessage", () => {
		const outcome = classifyRunOutcome([assistant({ stopReason: "error", errorMessage: "rate limited" })]);
		expect(outcome).toEqual({
			status: "failed",
			error: "rate limited",
			response: "rate limited",
		});
	});

	test("error with visible text prefers the text as response", () => {
		const outcome = classifyRunOutcome([
			assistant({ stopReason: "error", errorMessage: "boom", text: "partial answer" }),
		]);
		expect(outcome).toEqual({ status: "failed", error: "boom", response: "partial answer" });
	});

	test("classifies stopReason aborted as aborted", () => {
		expect(classifyRunOutcome([assistant({ stopReason: "aborted" })])).toEqual({ status: "aborted" });
	});

	test("user messages after the last assistant are skipped", () => {
		const outcome = classifyRunOutcome([
			assistant({ text: "done" }),
			{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		]);
		expect(outcome).toEqual({ status: "completed", response: "done" });
	});

	test("truncates long responses to the preview budget", () => {
		const outcome = classifyRunOutcome([assistant({ text: "x".repeat(500) })]);
		expect(outcome).toEqual({ status: "completed", response: `${"x".repeat(200)}…` });
	});

	test("truncates long errorMessage fallbacks", () => {
		const outcome = classifyRunOutcome([
			assistant({ stopReason: "error", errorMessage: "e".repeat(500) }),
		]);
		expect(outcome.status).toBe("failed");
		expect(outcome.response).toBe(`${"e".repeat(200)}…`);
	});

	test("no assistant message classifies as completed without response", () => {
		expect(classifyRunOutcome([{ role: "user", content: "hi" }])).toEqual({ status: "completed" });
		expect(classifyRunOutcome([])).toEqual({ status: "completed" });
	});
});

describe("truncateCodePoints", () => {
	test("keeps short text intact", () => {
		expect(truncateCodePoints("hello", 10)).toBe("hello");
	});

	test("counts code points, not UTF-16 units", () => {
		// "🚀🚀" is 4 UTF-16 units but 2 code points.
		expect(truncateCodePoints("🚀🚀🚀", 2)).toBe("🚀🚀…");
	});

	test("appends an ellipsis when truncated", () => {
		expect(truncateCodePoints("abcdef", 3)).toBe("abc…");
	});
});
