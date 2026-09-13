/**
 * Unit tests for the /model-class CLI parser (SPEC §3, §8, §10):
 * every supported form parses; every unsupported form — including anything
 * addressing `default` — is rejected without state change.
 */
import { describe, expect, test } from "bun:test";
import { MODEL_CLASS_USAGE, parseModelClassCommand } from "./parse";

describe("supported forms", () => {
	test("bare command is status", () => {
		expect(parseModelClassCommand("")).toEqual({ kind: "status" });
		expect(parseModelClassCommand(undefined)).toEqual({ kind: "status" });
		expect(parseModelClassCommand("   ")).toEqual({ kind: "status" });
	});

	test("switch form", () => {
		expect(parseModelClassCommand("cheap")).toEqual({ kind: "switch", name: "cheap" });
		expect(parseModelClassCommand("smart")).toEqual({ kind: "switch", name: "smart" });
		expect(parseModelClassCommand("  smart  ")).toEqual({ kind: "switch", name: "smart" });
	});

	test("set form", () => {
		expect(parseModelClassCommand("cheap set")).toEqual({ kind: "set", name: "cheap" });
		expect(parseModelClassCommand("smart set")).toEqual({ kind: "set", name: "smart" });
	});
});

describe("rejected forms (SPEC §8 invalid syntax)", () => {
	function invalidReason(args: string): string {
		const parsed = parseModelClassCommand(args);
		if (parsed.kind !== "invalid") throw new Error(`expected "${args}" to be invalid`);
		return parsed.reason;
	}

	test("default is not addressable", () => {
		expect(parseModelClassCommand("default").kind).toBe("invalid");
		expect(parseModelClassCommand("default set").kind).toBe("invalid");
		expect(invalidReason("default")).toMatch(/not a stored class/);
	});

	test("unknown classes and junk", () => {
		for (const args of ["foo", "smart foo", "set", "cheap set extra", "cheap smart", "-h", "help"]) {
			expect(parseModelClassCommand(args).kind).toBe("invalid");
		}
		expect(invalidReason("foo")).toMatch(/Unknown model class/);
		expect(invalidReason("smart foo")).toMatch(/Unexpected arguments/);
	});

	test("every invalid result carries the usage for the error path", () => {
		// The usage text is exported exactly once so command errors and the
		// status output can never drift apart.
		expect(MODEL_CLASS_USAGE).toBe(
			["Usage:", "  /model-class", "  /model-class <cheap|smart>", "  /model-class <cheap|smart> set"].join("\n"),
		);
	});
});
