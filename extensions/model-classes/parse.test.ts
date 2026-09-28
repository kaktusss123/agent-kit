/**
 * Unit tests for the /model-class CLI parser (SPEC R2): every supported
 * form parses — including named classes, next/unset, and the route family —
 * and every unsupported form (reserved words, bad grammar, junk) is
 * rejected without state change.
 */
import { describe, expect, test } from "bun:test";
import { MODEL_CLASS_USAGE, parseModelClassCommand } from "./parse";
import { isClassName } from "./store";

describe("supported forms", () => {
	test("bare command is status", () => {
		expect(parseModelClassCommand("")).toEqual({ kind: "status" });
		expect(parseModelClassCommand(undefined)).toEqual({ kind: "status" });
		expect(parseModelClassCommand("   ")).toEqual({ kind: "status" });
	});

	test("switch form accepts any grammar-valid class name", () => {
		expect(parseModelClassCommand("cheap")).toEqual({ kind: "switch", name: "cheap" });
		expect(parseModelClassCommand("smart")).toEqual({ kind: "switch", name: "smart" });
		expect(parseModelClassCommand("workhorse")).toEqual({ kind: "switch", name: "workhorse" });
		expect(parseModelClassCommand("  heavy  ")).toEqual({ kind: "switch", name: "heavy" });
		expect(parseModelClassCommand("deep-review-2")).toEqual({ kind: "switch", name: "deep-review-2" });
	});

	test("set / unset forms", () => {
		expect(parseModelClassCommand("cheap set")).toEqual({ kind: "set", name: "cheap" });
		expect(parseModelClassCommand("smart set")).toEqual({ kind: "set", name: "smart" });
		expect(parseModelClassCommand("workhorse unset")).toEqual({ kind: "unset", name: "workhorse" });
	});

	test("next", () => {
		expect(parseModelClassCommand("next")).toEqual({ kind: "next" });
	});

	test("route status", () => {
		expect(parseModelClassCommand("route")).toEqual({ kind: "routeStatus" });
	});

	test("route set/reset forms", () => {
		expect(parseModelClassCommand("route plain workhorse")).toEqual({
			kind: "routeSet",
			mode: "plain",
			target: "workhorse",
		});
		expect(parseModelClassCommand("route repoOwner heavy")).toEqual({
			kind: "routeSet",
			mode: "repoOwner",
			target: "heavy",
		});
		expect(parseModelClassCommand("route plain inherit")).toEqual({
			kind: "routeSet",
			mode: "plain",
			target: "inherit",
		});
		expect(parseModelClassCommand("route repoOwner inherit")).toEqual({
			kind: "routeSet",
			mode: "repoOwner",
			target: "inherit",
		});
	});
});

describe("rejected forms", () => {
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

	test("every reserved word is rejected as a class name", () => {
		for (const word of ["default", "inherit", "route", "next", "set", "unset", "routing"]) {
			expect(isClassName(word), word).toBe(false);
			expect(parseModelClassCommand(`${word} set`).kind, `${word} set`).toBe("invalid");
		}
		// words that collide with subcommands parse AS those subcommands alone
		expect(parseModelClassCommand("next")).toEqual({ kind: "next" });
		expect(parseModelClassCommand("route")).toEqual({ kind: "routeStatus" });
		// the rest are rejected as single tokens too
		for (const word of ["inherit", "set", "unset", "routing"]) {
			expect(parseModelClassCommand(word).kind, word).toBe("invalid");
		}
		expect(invalidReason("inherit")).toMatch(/reserved word/);
		expect(invalidReason("routing")).toMatch(/reserved word/);
	});

	test("grammar violations are rejected with the rule", () => {
		for (const bad of ["Foo", "1st", "-lead", "with space", "under_score", "dot.name", "x".repeat(33)]) {
			expect(parseModelClassCommand(bad).kind, bad).toBe("invalid");
		}
		expect(invalidReason("Foo")).toMatch(/Invalid class name/);
	});

	test("route-specific rejections", () => {
		expect(parseModelClassCommand("route plain").kind).toBe("invalid");
		expect(invalidReason("route plain")).toMatch(/needs a target/);
		expect(parseModelClassCommand("route plain default").kind).toBe("invalid");
		expect(invalidReason("route plain default")).toMatch(/inherit/);
		expect(parseModelClassCommand("route badmode workhorse").kind).toBe("invalid");
		expect(invalidReason("route badmode workhorse")).toMatch(/Unknown spawn mode/);
		expect(parseModelClassCommand("route plain Foo!").kind).toBe("invalid");
		expect(parseModelClassCommand("route plain workhorse extra").kind).toBe("invalid");
	});

	test("unknown classes and junk", () => {
		for (const args of ["smart foo", "cheap set extra", "cheap smart", "-h", "next set"]) {
			expect(parseModelClassCommand(args).kind).toBe("invalid");
		}
		expect(invalidReason("smart foo")).toMatch(/Unexpected arguments/);
		expect(invalidReason("next set")).toMatch(/reserved word/);
	});

	test("the usage text is exported exactly once and covers every form", () => {
		expect(MODEL_CLASS_USAGE).toBe(
			[
				"Usage:",
				"  /model-class",
				"  /model-class <class>",
				"  /model-class <class> set",
				"  /model-class <class> unset",
				"  /model-class next",
				"  /model-class route",
				"  /model-class route <plain|repoOwner> <class|inherit>",
			].join("\n"),
		);
	});
});
