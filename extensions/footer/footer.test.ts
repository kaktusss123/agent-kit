import { describe, expect, test } from "bun:test";
import { costParts } from "./index";

describe("costParts", () => {
	test("main-only cost below subagent threshold shows no parentheses", () => {
		expect(costParts(0.5, 0)).toEqual({ main: "0.50", grand: null });
	});

	test("subagent spend adds the grand total (main + subagents)", () => {
		expect(costParts(0.5, 1.85)).toEqual({ main: "0.50", grand: "2.35" });
	});

	test("negligible main cost is still shown when subagents spent", () => {
		expect(costParts(0.001, 0.5)).toEqual({ main: "0.00", grand: "0.50" });
	});

	test("nothing spent shows nothing", () => {
		expect(costParts(0.001, 0)).toEqual({ main: null, grand: null });
	});

	test("half-a-cent threshold is inclusive", () => {
		expect(costParts(0.005, 0).main).not.toBeNull();
		expect(costParts(0, 0.005).grand).not.toBeNull();
		expect(costParts(0.004, 0).main).toBeNull();
	});
});
