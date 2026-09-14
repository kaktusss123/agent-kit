import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { AskSchema } from "./ask-schema";
import { findReservedOptionLabel } from "./contract";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_GUIDELINES,
	formatAskOutcomeText,
	formatAskRequestFlat,
	formatAskRequestJson,
	normalizeAskArguments,
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

describe("normalizeAskArguments", () => {
	test("repairs the observed failure: recommended flags embedded in options", () => {
		const raw = {
			questions: [
				{
					id: "layout",
					question: "Layout?",
					options: [
						{ label: "One file", description: "a", recommended: true },
						{ label: "Two files", description: "b", recommended: true },
					],
				},
			],
		};
		const fixed = normalizeAskArguments(raw);
		expect(fixed.questions[0]!.recommended).toBe(0);
		expect(fixed.questions[0]!.options).toEqual([
			{ label: "One file", description: "a" },
			{ label: "Two files", description: "b" },
		]);
		// End-to-end: the raw payload is rejected by the strict schema that
		// produced the real-world validation error; the repaired one passes.
		expect(Value.Check(AskSchema, raw)).toBe(false);
		expect(Value.Check(AskSchema, fixed)).toBe(true);
	});

	test("repairs question-level boolean and label recommendations", () => {
		const asIndex = (recommended: unknown) =>
			normalizeAskArguments({
				questions: [
					{ id: "x", question: "q", options: [{ label: "a" }, { label: " b " }], recommended },
				],
			}).questions[0]!.recommended;
		expect(asIndex(true)).toBe(0);
		expect(asIndex(false)).toBeUndefined();
		expect(asIndex(" b ")).toBe(1); // exact label match
		expect(asIndex("B")).toBe(1); // trimmed + case-insensitive fallback
		expect(asIndex("nope")).toBeUndefined();
	});

	test("explicit question-level recommendation wins over embedded flags", () => {
		const fixed = normalizeAskArguments({
			questions: [
				{
					id: "x",
					question: "q",
					options: [{ label: "a", recommended: true }, { label: "b" }],
					recommended: 1,
				},
			],
		});
		expect(fixed.questions[0]!.recommended).toBe(1);
	});

	test("drops unknown extra properties at every level", () => {
		const fixed = normalizeAskArguments({
			title: "stray",
			questions: [{ id: "x", question: "q", note: "n", options: [{ label: "a", icon: "i" }] }],
		});
		expect(fixed).toEqual({ questions: [{ id: "x", question: "q", options: [{ label: "a" }] }] });
	});

	test("passes unrepairable payloads through unchanged", () => {
		const raw = { questions: [{ id: "x", options: "nope" }] };
		expect(normalizeAskArguments(raw)).toEqual(raw);
		expect(normalizeAskArguments(undefined)).toBeUndefined();
		expect(normalizeAskArguments("nope")).toBe("nope");
		expect(normalizeAskArguments({ questions: "nope" })).toEqual({ questions: "nope" });
	});

	test("leaves canonical input unchanged", () => {
		expect(normalizeAskArguments(sample)).toEqual(sample);
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
		// neutral text: the execute layer aborts the turn on cancellation, so
		// this text must not license continuing on uncertainty
		const cancelled = formatAskOutcomeText({ kind: "cancelled" });
		expect(cancelled).toContain("dismissed");
		expect(cancelled).not.toMatch(/continue|uncertainty/i);
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

describe("schema/validator drift guard", () => {
	test("typebox schema fields match what validateAskInput enforces", () => {
		const qSchema = (AskSchema.properties.questions as {
			items: { properties: Record<string, unknown>; required?: string[] };
		}).items;
		expect(Object.keys(qSchema.properties).sort()).toEqual([
			"header",
			"id",
			"multi",
			"options",
			"question",
			"recommended",
		]);
		expect([...(qSchema.required ?? [])].sort()).toEqual(["id", "options", "question"]);
		const oSchema = (
			qSchema.properties.options as { items: { properties: Record<string, unknown>; required?: string[] } }
		).items;
		expect(Object.keys(oSchema.properties).sort()).toEqual(["description", "label", "preview"]);
		expect([...(oSchema.required ?? [])]).toEqual(["label"]);

		// a payload shaped exactly like the schema validates
		const full = {
			id: "x",
			question: "q",
			header: "h",
			options: [{ label: "l", description: "d", preview: "p" }],
			multi: true,
			recommended: 0,
		};
		expect(validateAskInput({ questions: [full] })).toBeDefined();
	});
});

describe("findReservedOptionLabel (OMP reserved labels)", () => {
	test("flags runtime control labels", () => {
		const request: AskInput = {
			questions: [
				{
					id: "q",
					question: "Q?",
					options: [{ label: "Chat about this" }, { label: "fine" }],
				},
			],
		};
		expect(findReservedOptionLabel(request)).toBe("Chat about this");
	});

	test("clean requests pass", () => {
		const request: AskInput = {
			questions: [{ id: "q", question: "Q?", options: [{ label: "a" }, { label: "b" }] }],
		};
		expect(findReservedOptionLabel(request)).toBeUndefined();
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
