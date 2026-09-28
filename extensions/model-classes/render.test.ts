/**
 * Unit tests for /model-class rendering: status (session + classes in
 * storage order + routing table with resolved models), the visible MISSING
 * CLASS flag for routes to unsaved classes, and the confirmations.
 */
import { describe, expect, test } from "bun:test";
import {
	renderModelClassStatus,
	renderRouteSet,
	renderRoutingTable,
	renderSaved,
	renderSwitched,
	renderUnset,
} from "./render";
import { MODEL_CLASS_USAGE } from "./parse";
import type { StoredClasses } from "./store";

const CLASSES: StoredClasses = {
	workhorse: { model: "cloudru/openai/gpt-oss-120b", thinking: "medium" },
	heavy: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
};

describe("renderModelClassStatus", () => {
	test("no saved classes, no routing: session row + inherit rows + usage", () => {
		const out = renderModelClassStatus({ name: "default", model: "model-A", thinking: "high" }, {}, {});
		expect(out).toBe(
			[
				"Model classes",
				"",
				"default  model-A    high",
				"",
				"Routing (spawn-mode defaults)",
				"",
				"plain      inherit  (session pair)",
				"repoOwner  inherit  (session pair)",
				"",
				MODEL_CLASS_USAGE,
			].join("\n"),
		);
	});

	test("classes render in storage order with aligned columns", () => {
		const out = renderModelClassStatus(
			{ name: "default", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
			CLASSES,
			{},
		);
		const lines = out.split("\n");
		expect(lines[0]).toBe("Model classes");
		expect(lines[2]).toBe("default     openai-codex/gpt-5.6-sol       high");
		expect(lines[3]).toBe("workhorse   cloudru/openai/gpt-oss-120b    medium");
		expect(lines[4]).toBe("heavy       openai-codex/gpt-5.6-sol       high");
		// The thinking column starts at the same offset on every row.
		const thinkingCol = (line: string) => {
			const m = line.match(/(high|medium)$/);
			return m ? m.index : -1;
		};
		expect(thinkingCol(lines[2])).toBe(thinkingCol(lines[3]));
		expect(thinkingCol(lines[3])).toBe(thinkingCol(lines[4]));
		// no active-class marker, ever
		expect(out).not.toContain("*");
		expect(out.toLowerCase()).not.toContain("active");
	});

	test("routing rows show resolved models for routed modes (A2/A3 views)", () => {
		const out = renderModelClassStatus(
			{ name: "default", model: "zai/glm-x", thinking: "low" },
			CLASSES,
			{ plain: "workhorse", repoOwner: "heavy" },
		);
		const routing = out.split("\n").slice(6, 10);
		expect(routing).toEqual([
			"Routing (spawn-mode defaults)",
			"",
			"plain      workhorse  (cloudru/openai/gpt-oss-120b, medium)",
			"repoOwner  heavy      (openai-codex/gpt-5.6-sol, high)",
		]);
	});

	test("routes to missing classes are visibly flagged, never hidden (R2)", () => {
		const out = renderRoutingTable(CLASSES, { plain: "nosuch" });
		expect(out).toContain("nosuch");
		expect(out).toContain("NOT SAVED");
		expect(out).toContain("/model-class nosuch set");
		expect(out).toContain("/model-class route plain inherit");
		// the healthy mode still renders normally
		expect(out).toContain("repoOwner  inherit  (session pair)");
	});

	test("a routed inherited-property name (`constructor`) flags NOT SAVED, never renders garbage", () => {
		const out = renderRoutingTable(CLASSES, { plain: "constructor" });
		expect(out).toContain("NOT SAVED");
		expect(out).toContain("/model-class route plain inherit");
		expect(out).not.toContain("(undefined, undefined)");
	});

	test("a present-but-empty route target flags NOT SAVED, never renders as inherit (R2)", () => {
		const out = renderRoutingTable(CLASSES, { plain: "" });
		expect(out).toContain("NOT SAVED");
		expect(out).toContain("<empty>");
		expect(out).toContain("/model-class route plain inherit");
		// the healthy mode still renders normally
		expect(out).toContain("repoOwner  inherit  (session pair)");
		// the broken mode must not read as session inheritance
		expect(out).not.toMatch(/^plain\s+inherit/m);
	});

	test("absent (undefined) routing entry renders the inherit line", () => {
		const out = renderRoutingTable(CLASSES, {});
		expect(out).toContain("plain      inherit  (session pair)");
		expect(out).toContain("repoOwner  inherit  (session pair)");
	});

	test("session without a model renders an explicit row, not `not set`", () => {
		const out = renderModelClassStatus({ name: "default", model: "(no model in session)" }, {}, {});
		expect(out.split("\n")[2]).toBe("default  (no model in session)");
	});
});

describe("renderRoutingTable", () => {
	test("same block is used standalone (/model-class route) and in status", () => {
		const routing = { plain: "workhorse" as const };
		const status = renderModelClassStatus({ name: "default", model: "m", thinking: "low" }, CLASSES, routing);
		expect(status).toContain(renderRoutingTable(CLASSES, routing));
		// an unrouted mode reads as session inheritance (A10)
		expect(renderRoutingTable(CLASSES, routing)).toContain("repoOwner  inherit    (session pair)");
	});
});

describe("confirmations", () => {
	test("set / switch / unset one-liners", () => {
		expect(renderSaved("workhorse", "cloudru/openai/gpt-oss-120b", "medium")).toBe(
			"Saved workhorse: cloudru/openai/gpt-oss-120b, medium",
		);
		expect(renderSwitched("heavy", "openai-codex/gpt-5.6-sol", "high")).toBe(
			"Switched to heavy: openai-codex/gpt-5.6-sol, high",
		);
		expect(renderUnset("heavy")).toBe("Deleted model class heavy");
	});

	test("route set / reset one-liners (with the resolved pair when known)", () => {
		expect(renderRouteSet("plain", "workhorse", CLASSES.workhorse)).toBe(
			"Routing plain: workhorse (cloudru/openai/gpt-oss-120b, medium)",
		);
		expect(renderRouteSet("plain", "workhorse")).toBe("Routing plain: workhorse");
		expect(renderRouteSet("repoOwner", "inherit")).toBe("Routing repoOwner: inherit (session pair)");
	});
});
