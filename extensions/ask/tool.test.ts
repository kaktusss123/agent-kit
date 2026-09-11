import { describe, expect, test } from "bun:test";
import { buildAskTool, rpcFallbackAsk } from "./tool";
import { buildChildAskTool } from "../subagents/bridge-ask";

// ===========================================================================
// Schema/name parity (SPEC I1, I2): Main tool and child tool are the SAME
// model-facing surface — one name, one schema, one description.
// ===========================================================================

describe("ask tool parity across roles", () => {
	test("main and child tools share name, schema, description, guidelines", () => {
		const main = buildAskTool(async () => ({ kind: "cancelled" }));
		const child = buildChildAskTool();
		expect(main.name).toBe("ask");
		expect(child.name).toBe("ask");
		expect(JSON.stringify(main.parameters)).toBe(JSON.stringify(child.parameters));
		expect(main.description).toBe(child.description);
		expect(main.promptGuidelines).toEqual(child.promptGuidelines);
		expect(main.executionMode).toBe("sequential");
	});

	test("child tool never mentions parents or routing (I4)", () => {
		const child = buildChildAskTool();
		const serialized = JSON.stringify({ d: child.description, g: child.promptGuidelines });
		expect(serialized).not.toMatch(/parent|controller|main\b/i);
	});
});

// ===========================================================================
// buildAskTool behavior with a fake backend
// ===========================================================================

describe("buildAskTool", () => {
	test("returns formatted answers and OMP-shaped details (single question)", async () => {
		const tool = buildAskTool(async () => ({
			kind: "answers" as const,
			results: [
				{ id: "db", question: "Which db?", options: ["pg", "sqlite"], multi: false, selectedOptions: ["pg"] },
			],
		}));
		const result = await tool.execute("t1", { questions: [{ id: "db", question: "Which db?", options: [{ label: "pg" }, { label: "sqlite" }] }] }, undefined, undefined, undefined);
		expect(result.content[0]!.text).toBe("User selected: pg");
		expect(result.details).toMatchObject({ question: "Which db?", selectedOptions: ["pg"] });
	});

	test("multi-question results keep per-question structure", async () => {
		const tool = buildAskTool(async () => ({
			kind: "answers" as const,
			results: [
				{ id: "a", question: "A?", options: ["x"], multi: false, selectedOptions: ["x"] },
				{ id: "b", question: "B?", options: ["y"], multi: true, selectedOptions: ["y"] },
			],
		}));
		const result = await tool.execute("t", { questions: [{ id: "a", question: "A?", options: [{ label: "x" }] }, { id: "b", question: "B?", options: [{ label: "y" }], multi: true }] }, undefined, undefined, undefined);
		expect(result.content[0]!.text).toContain("User answers:");
		expect((result.details as { results: unknown[] }).results).toHaveLength(2);
	});

	test("chat redirect and cancellation are explicit outcomes", async () => {
		const tool = buildAskTool(async () => ({ kind: "chat" as const }));
		const result = await tool.execute("t", { questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] }, undefined, undefined, undefined);
		expect(result.details).toMatchObject({ chatRedirect: true });

		const cancelled = buildAskTool(async () => ({ kind: "cancelled" as const }));
		const result2 = await cancelled.execute("t", { questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] }, undefined, undefined, undefined);
		expect(result2.details).toMatchObject({ cancelled: true });
	});

	test("fail closed: unavailable backend returns an explicit error (A12)", async () => {
		const tool = buildAskTool(async () => ({ unavailable: "no interactive UI in this environment" }));
		const result = await tool.execute("t", { questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] }, undefined, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("no interactive UI");
	});

	test("empty questions guard", async () => {
		const tool = buildAskTool(async () => ({ kind: "cancelled" as const }));
		const result = await tool.execute("t", { questions: [] }, undefined, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("questions must not be empty");
	});
});

// ===========================================================================
// RPC fallback (degraded hosts) with a scripted ui
// ===========================================================================

interface ScriptStep {
	expect: { kind: "select" | "input"; title?: string };
	reply: string | undefined;
}

function scriptedUi(steps: ScriptStep[]) {
	const calls: Array<{ kind: string; title: string; options?: string[] }> = [];
	let i = 0;
	return {
		calls,
		ui: {
			async select(title: string, options: string[]) {
				calls.push({ kind: "select", title, options });
				const step = steps[i++];
				if (!step) throw new Error(`unexpected select: ${title}`);
				if (step.expect.kind !== "select") throw new Error(`expected input, got select: ${title}`);
				if (step.expect.title && step.expect.title !== title) {
					throw new Error(`expected title "${step.expect.title}", got "${title}"`);
				}
				return step.reply;
			},
			async input(title: string) {
				calls.push({ kind: "input", title });
				const step = steps[i++];
				if (!step) throw new Error(`unexpected input: ${title}`);
				if (step.expect.kind !== "input") throw new Error(`expected select, got input: ${title}`);
				return step.reply;
			},
		},
		left() {
			return steps.slice(i);
		},
	};
}

const oneQuestion = [{ id: "db", question: "Which db?", options: [{ label: "pg" }, { label: "sqlite", description: "embedded" }] }];

describe("rpcFallbackAsk", () => {
	test("single select flows through review and submit", async () => {
		const { ui, left } = scriptedUi([
			{ expect: { kind: "select", title: "Which db?" }, reply: "sqlite — embedded" },
			{ expect: { kind: "select", title: "Review your answers" }, reply: "Submit answers" },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{ id: "db", question: "Which db?", options: ["pg", "sqlite"], multi: false, selectedOptions: ["sqlite"] },
			],
		});
		expect(left()).toHaveLength(0);
	});

	test("Other captures free-form input", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: "Other (type your own)" },
			{ expect: { kind: "input", title: "Which db?" }, reply: "postgres 17" },
			{ expect: { kind: "select" }, reply: "Submit answers" },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome.kind).toBe("answers");
		if (outcome.kind === "answers") {
			expect(outcome.results[0]!.customInput).toBe("postgres 17");
		}
	});

	test("multi-select re-opens with checkmarks until Done", async () => {
		const q = { id: "s", question: "Scopes?", options: [{ label: "api" }, { label: "ui" }], multi: true };
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: "☐ api" }, // toggle on -> re-open
			{ expect: { kind: "select" }, reply: "☑ api" }, // toggle off -> re-open
			{ expect: { kind: "select" }, reply: "☐ api" }, // on again
			{ expect: { kind: "select" }, reply: "✓ Done selecting" },
			{ expect: { kind: "select" }, reply: "Submit answers" },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		expect(calls.filter((c) => c.kind === "select")).toHaveLength(5);
		expect(outcome).toEqual({
			kind: "answers",
			results: [{ id: "s", question: "Scopes?", options: ["api", "ui"], multi: true, selectedOptions: ["api"] }],
		});
	});

	test("chat is available in the fallback", async () => {
		const { ui } = scriptedUi([{ expect: { kind: "select" }, reply: "Chat about this" }]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({ kind: "chat" });
	});

	test("dismissed dialog is a cancellation, never a selection", async () => {
		const { ui } = scriptedUi([{ expect: { kind: "select" }, reply: undefined }]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({ kind: "cancelled" });
	});

	test("revise preserves answers and allows changing them", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: "pg" },
			{ expect: { kind: "select" }, reply: "Revise answers" },
			{ expect: { kind: "select" }, reply: "sqlite — embedded" },
			{ expect: { kind: "select" }, reply: "Submit answers" },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		if (outcome.kind === "answers") {
			expect(outcome.results[0]!.selectedOptions).toEqual(["sqlite"]);
		} else {
			throw new Error("expected answers");
		}
	});
});
