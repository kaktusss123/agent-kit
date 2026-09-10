import { describe, expect, test } from "bun:test";
import {
	type TextUsageRow,
	CACHE_READ_ICON,
	formatDuration,
	formatToolRow,
	formatTokens,
	formatUsageRow,
	formatUsageTimestamp,
	tokensPerSecond,
} from "./format";

/** Local-time fixture so the timestamp contract is TZ-independent. */
const ts = new Date(2026, 8, 10, 22, 30, 15).getTime();

function row(overrides: Partial<TextUsageRow> = {}): TextUsageRow {
	return {
		kind: "text",
		timestamp: ts,
		input: 100,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		durationMs: 4000,
		...overrides,
	};
}

describe("formatUsageTimestamp", () => {
	test("renders local YYYY-MM-DD HH:mm:ss", () => {
		expect(formatUsageTimestamp(ts)).toBe("2026-09-10 22:30:15");
	});
});

describe("formatUsageRow", () => {
	test("baseline: timestamp, input, output, TPS over full duration", () => {
		// 200 tokens / 4000ms → 50.0/s; TTFT/cache/Δ absent by contract.
		expect(formatUsageRow(row())).toBe("2026-09-10 22:30:15  ⤵ 100  ⤴ 200  ⚡ 50.0/s");
	});

	test("cacheWrite bills into the input figure", () => {
		const line = formatUsageRow(row({ cacheWrite: 500 }));
		expect(line).toContain("⤵ 600");
	});

	test("cacheRead segment appears only when non-zero", () => {
		expect(formatUsageRow(row())).not.toContain(CACHE_READ_ICON);
		expect(formatUsageRow(row({ cacheRead: 45_678 }))).toContain(
			`${CACHE_READ_ICON} ${formatTokens(45_678)}`,
		);
	});

	test("TTFT segment appears only when measured", () => {
		expect(formatUsageRow(row())).not.toContain("⏱");
		expect(formatUsageRow(row({ ttftMs: 1234 }))).toContain("⏱ 1.2s");
	});

	test("turn delta renders when anchored, omitted when not", () => {
		expect(formatUsageRow(row({ turnElapsedMs: 65_000 }))).toContain("Δ 1m 5s");
		expect(formatUsageRow(row({ turnElapsedMs: 0 }))).not.toContain("Δ");
	});

	test("TPS hidden under the 100ms duration floor (cached/instant responses)", () => {
		expect(formatUsageRow(row({ durationMs: 50 }))).not.toContain("⚡");
	});

	test("TPS hidden with zero output", () => {
		expect(formatUsageRow(row({ output: 0 }))).not.toContain("⚡");
	});

	test("fractional duration never leaks a raw float", () => {
		const line = formatUsageRow(row({ durationMs: 1234.567891, ttftMs: 100.4999 }));
		expect(line).not.toMatch(/\d+\.\d+ms/);
		expect(line).toContain("⤴ 200");
	});
});

describe("tokensPerSecond", () => {
	test("divides output by full duration", () => {
		expect(tokensPerSecond(2000, 4000)).toBe(500);
	});

	test("undefined at or below the duration floor", () => {
		expect(tokensPerSecond(200, 100)).toBeUndefined();
		expect(tokensPerSecond(200, 50)).toBeUndefined();
	});

	test("undefined with zero or negative output", () => {
		expect(tokensPerSecond(0, 4000)).toBeUndefined();
	});
});

describe("formatDuration", () => {
	test("milliseconds below 1s", () => {
		expect(formatDuration(450)).toBe("450ms");
	});

	test("seconds below 1m with one decimal", () => {
		expect(formatDuration(12_340)).toBe("12.3s");
	});

	test("minutes with rounded seconds", () => {
		expect(formatDuration(65_000)).toBe("1m 5s");
	});
});

describe("formatToolRow", () => {
	test("tool name plus duration", () => {
		expect(formatToolRow({ kind: "tool", toolName: "bash", execTimeMs: 1234 })).toBe("bash: 1.2s");
	});
});
