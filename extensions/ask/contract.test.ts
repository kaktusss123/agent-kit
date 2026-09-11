import { describe, expect, test } from "bun:test";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_GUIDELINES,
	formatAskOutcomeText,
	formatAskRequestFlat,
	formatAskRequestJson,
	parseAskRequest,
	validateAskInput,
	type AskInput,
} from "./contract";

const sample: AskInput = {
	questions: [
		{
			id: "base_branch",
			question: "Which base branch?",
			header: "Branch",
			options: [
				{ label: "main", description: "stable", preview: "```js\ncode\n```" },
				{ label: "develop", description: "integration" },
			],
			multi: false,
			recommended: 1,
		},
		{ id: "scope", question: "Scope?", options: [{ label: "a" }, { label: "b" }], multi: true },
	],
};

describe("validateAskInput", () => {
	test("accepts a canonical request", () => {
		expect(validateAskInput(sample)).toEqual(sample);
	});

	test("rejects malformed payloads", () => {
		expect(validateAskInput(undefined)).toBeUndefined();
		expect(validateAskInput("nope")).toBeUndefined();
		expect(validateAskInput({})).toBeUndefined();
		expect(validateAskInput({ questions: [] })).toBeUndefined();
		expect(validateAskInput({ questions: [{ id: "x", question: "q" }] })).toBeUndefined();
		expect(
			validateAskInput({ questions: [{ id: "x", question: "q", options: [{ label: 5 }] }] }),
		).toBeUndefined();
		expect(
			validateAskInput({ questions: [{ id: "x", question: 3, options: [{ label: "a" }] }] }),
		).toBeUndefined();
	});

	test("is lenient about extra fields (transport future-proofing)", () => {
		const padded = { questions: [{ ...sample.questions[0], note: "extra" }], extra: true };
		expect(validateAskInput(padded)).toBeDefined();
	});
});

describe("parseAskRequest", () => {
	test("round-trips through JSON", () => {
		const parsed = parseAskRequest(JSON.stringify(sample));
		expect(parsed).toEqual(sample);
	});

	test("fails closed on garbage", () => {
		expect(parseAskRequest(undefined)).toBeUndefined();
		expect(parseAskRequest("")).toBeUndefined();
		expect(parseAskRequest("plain prose")).toBeUndefined();
		expect(parseAskRequest("{\"foo\":1}")).toBeUndefined();
	});
});

describe("formatting", () => {
	test("flat rendering summarizes every question on one line", () => {
		const flat = formatAskRequestFlat(sample);
		expect(flat).toContain("base_branch: Which base branch? (main | develop)");
		expect(flat).toContain("scope: Scope? (a | b) [multi]");
	});

	test("json rendering is lossless", () => {
		expect(JSON.parse(formatAskRequestJson(sample))).toEqual(sample);
	});

	test("outcome text mirrors the OMP shapes", () => {
		expect(formatAskOutcomeText({ kind: "chat" })).toContain("chat about this");
		expect(formatAskOutcomeText({ kind: "cancelled" })).toContain("dismissed");
		expect(
			formatAskOutcomeText({
				kind: "answers",
				results: [
					{ id: "q", question: "Q?", options: ["a", "b"], multi: false, selectedOptions: ["b"] },
				],
			}),
		).toBe("User selected: b");
		expect(
			formatAskOutcomeText({
				kind: "answers",
				results: [
					{
						id: "q1",
						question: "Q1?",
						options: ["a", "b"],
						multi: false,
						selectedOptions: ["a"],
						customInput: "custom note",
					},
					{ id: "q2", question: "Q2?", options: ["x"], multi: true, selectedOptions: [] },
				],
			}),
		).toBe("User answers:\nq1: \"custom note\"\nq2: (no answer)");
	});
});

describe("role-neutral contract surface", () => {
	test("description and guidelines never mention roles or transports", () => {
		const forbidden = /parent|subagent|rpc|tui|transport|control plane|headless|main\b/i;
		expect(forbidden.test(ASK_TOOL_DESCRIPTION)).toBe(false);
		for (const guideline of ASK_TOOL_GUIDELINES) {
			expect(forbidden.test(guideline)).toBe(false);
		}
	});
});
