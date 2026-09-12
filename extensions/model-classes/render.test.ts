/**
 * Unit tests for /model-class status rendering (SPEC §3, §10): three rows,
 * `not set` for unconfigured classes, no active-class marker, usage block.
 */
import { describe, expect, test } from "bun:test";
import { renderModelClassStatus, renderSaved, renderSwitched } from "./render";
import { MODEL_CLASS_USAGE } from "./parse";

describe("renderModelClassStatus", () => {
	test("A1: no saved classes", () => {
		const out = renderModelClassStatus(
			{ name: "default", model: "model-A", thinking: "high" },
			{},
		);
		expect(out).toBe(
			[
				"Model classes",
				"",
				"default  model-A    high",
				"cheap    not set",
				"smart    not set",
				"",
				MODEL_CLASS_USAGE,
			].join("\n"),
		);
	});

	test("matches the SPEC §3 layout with aligned columns", () => {
		const out = renderModelClassStatus(
			{ name: "default", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
			{
				cheap: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
				smart: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
			},
		);
		const lines = out.split("\n");
		expect(lines[0]).toBe("Model classes");
		expect(lines[2]).toBe("default  openai-codex/gpt-5.6-sol       high");
		expect(lines[3]).toBe("cheap    cloudru/openai/gpt-oss-120b    medium");
		expect(lines[4]).toBe("smart    openai-codex/gpt-5.6-sol       high");
		// The thinking column starts at the same offset on every row.
		const thinkingCol = (line: string) => {
			const m = line.match(/(high|medium)$/);
			return m ? m.index : -1;
		};
		expect(thinkingCol(lines[2])).toBe(thinkingCol(lines[3]));
		expect(thinkingCol(lines[3])).toBe(thinkingCol(lines[4]));
		// A3: after switching to cheap, default shows the same pair — no marker.
		const switched = renderModelClassStatus(
			{ name: "default", model: "model-B", thinking: "medium" },
			{ cheap: { model: "model-B", thinking: "medium" } },
		);
		expect(switched.split("\n").slice(2, 4)).toEqual(["default  model-B    medium", "cheap    model-B    medium"]);
		expect(switched).not.toContain("*");
		expect(switched.toLowerCase()).not.toContain("active");
		expect(switched).toContain(MODEL_CLASS_USAGE);
	});

	test("session without a model renders an explicit row, not `not set`", () => {
		const out = renderModelClassStatus({ name: "default", model: "(no model in session)" }, {});
		expect(out.split("\n")[2]).toBe("default  (no model in session)");
	});
});

describe("confirmations", () => {
	test("set / switch one-liners (SPEC §3)", () => {
		expect(renderSaved("cheap", "cloudru/openai/gpt-oss-120b", "medium")).toBe(
			"Saved cheap: cloudru/openai/gpt-oss-120b, medium",
		);
		expect(renderSwitched("smart", "openai-codex/gpt-5.6-sol", "high")).toBe(
			"Switched to smart: openai-codex/gpt-5.6-sol, high",
		);
	});
});
