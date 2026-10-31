import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import {
	ASK_WIRE_VERSION,
	buildAskTool,
	rpcFallbackAsk,
	tryParseWireItem,
	type AskWireItem,
} from "./tool.ts";
import { buildChildAskTool } from "../subagents/bridge-ask.ts";

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

	test("child guard rejects reserved labels before the transport hop (F3)", async () => {
		const child = buildChildAskTool();
		let uiCalled = false;
		const result = await child.execute(
			"t",
			{
				questions: [
					{ id: "q", question: "Q?", options: [{ label: "fine" }, { label: "Type a response…" }] },
				],
			},
			undefined,
			undefined,
			{
				ui: {
					input() {
						uiCalled = true;
						return Promise.resolve(undefined);
					},
				},
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Type a response…");
		expect(uiCalled).toBe(false);
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

	test("legacy chat outcome stays tolerated (no surface produces it since ZAVOD-30)", async () => {
		const tool = buildAskTool(async () => ({ kind: "chat" as const }));
		const result = await tool.execute("t", { questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] }, undefined, undefined, undefined);
		expect(result.details).toMatchObject({ chatRedirect: true });
		expect(result.isError).toBeUndefined();
	});

	test("user dismissal aborts the turn via ctx.abort and keeps partial answers (F2, OMP parity)", async () => {
		let aborts = 0;
		const ctx = { abort: () => void (aborts += 1) };
		const partialResults = [
			{ id: "q", question: "Q?", options: ["a"], multi: false, selectedOptions: ["a"] },
		];
		const cancelled = buildAskTool(async () => ({ kind: "cancelled" as const, partialResults }));
		const result = await cancelled.execute(
			"t",
			{ questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] },
			undefined,
			undefined,
			ctx,
		);
		expect(aborts).toBe(1);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("cancelled by the user");
		expect(result.details).toMatchObject({ cancelled: true, partialResults });
	});

	test("fail closed: unavailable backend returns an explicit error (A12)", async () => {
		const tool = buildAskTool(async () => ({ unavailable: "no interactive UI in this environment" }));
		const result = await tool.execute("t", { questions: [{ id: "q", question: "Q?", options: [{ label: "a" }] }] }, undefined, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("no interactive UI");
	});

	test("reserved option labels fail the call before any backend runs (F3)", async () => {
		let backendRuns = 0;
		const tool = buildAskTool(async () => {
			backendRuns += 1;
			return { kind: "cancelled" as const };
		});
		const result = await tool.execute(
			"t",
			{
				questions: [
					{ id: "q", question: "Q?", options: [{ label: "Type a response…" }, { label: "b" }] },
				],
			},
			undefined,
			undefined,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Type a response…");
		expect(backendRuns).toBe(0);
	});

	test("\"Chat about this\" is no longer a reserved label: no runtime row collides with it", async () => {
		let backendRuns = 0;
		const tool = buildAskTool(async () => {
			backendRuns += 1;
			return { kind: "cancelled" as const };
		});
		const result = await tool.execute(
			"t",
			{
				questions: [{ id: "q", question: "Q?", options: [{ label: "Chat about this" }] }],
			},
			undefined,
			undefined,
			undefined,
		);
		expect(backendRuns).toBe(1);
		expect(result.details).toMatchObject({ cancelled: true });
	});

	test("empty questions guard", async () => {
		const tool = buildAskTool(async () => ({ kind: "cancelled" as const }));
		const result = await tool.execute("t", { questions: [] }, undefined, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("questions must not be empty");
	});
});

// ===========================================================================
// RPC fallback v2 (ask-v2 wire format) with a scripted ui
// ===========================================================================

type Reply =
	| string
	| undefined
	| ((title: string, options: string[] | undefined) => string | undefined);

interface ScriptStep {
	expect: { kind: "select" | "input"; title?: string };
	reply: Reply;
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
				return typeof step.reply === "function" ? step.reply(title, options) : step.reply;
			},
			async input(title: string) {
				calls.push({ kind: "input", title });
				const step = steps[i++];
				if (!step) throw new Error(`unexpected input: ${title}`);
				if (step.expect.kind !== "input") throw new Error(`expected select, got input: ${title}`);
				if (step.expect.title && step.expect.title !== title) {
					throw new Error(`expected title "${step.expect.title}", got "${title}"`);
				}
				if (typeof step.reply === "function") {
					throw new Error("input steps take literal replies only");
				}
				return step.reply;
			},
		},
		left() {
			return steps.slice(i);
		},
	};
}

/** Parse every emitted option; throws when any option is not wire JSON. */
function wireItems(options: string[]): AskWireItem[] {
	return options.map((s) => {
		const item = tryParseWireItem(s);
		if (!item) throw new Error(`expected ask-v2 wire JSON, got: ${s}`);
		return item;
	});
}

/** Reply with the exact emitted string of the first item of this kind (optionally filtered). */
function pickKind(kind: AskWireItem["kind"], predicate?: (item: AskWireItem) => boolean) {
	return (_title: string, options: string[] | undefined) => {
		const found = (options ?? []).find((s) => {
			const item = tryParseWireItem(s);
			return item?.kind === kind && (!predicate || predicate(item));
		});
		if (!found) throw new Error(`no ${kind} option in [${(options ?? []).join(" | ")}]`);
		return found;
	};
}

const pickOption = (label: string) => pickKind("option", (i) => i.label === label);
const pickNthOption = (label: string, n: number) => (_title: string, options: string[] | undefined) => {
	// JSON-aware dedup: every emitted string stays valid v1-JSON, later
	// identical copies carry an in-object `dup` differentiator — match the
	// nth parsed item with this label and return its exact emitted string,
	// so the driver resolves it positionally by exact match.
	const matches = (options ?? []).filter((s) => tryParseWireItem(s)?.label === label);
	if (matches.length <= n) throw new Error(`only ${matches.length} options labeled "${label}"`);
	return matches[n]!;
};
const pickOther = () => pickKind("other");
const pickDone = () => pickKind("done");
const pickSubmit = () => pickKind("submit");
const pickReviseAll = () => pickKind("revise-all");
const pickReviseQ = (q: number) => pickKind("revise-q", (i) => i.q === q);

const oneQuestion = [{ id: "db", question: "Which db?", options: [{ label: "pg" }, { label: "sqlite", description: "embedded" }] }];

describe("rpcFallbackAsk wire format (ZAVOD-30 §2.1)", () => {
	test("question dialog: human title, JSON options, exactly one meta, no chat-removed", async () => {
		const { ui, calls, left } = scriptedUi([
			{ expect: { kind: "select", title: "Which db?" }, reply: pickOption("sqlite") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(left()).toHaveLength(0);
		if (outcome.kind !== "answers") throw new Error("expected answers");

		const questionCall = calls[0]!;
		expect(questionCall.title).toBe("Which db?");
		const items = wireItems(questionCall.options!);
		for (const item of items) expect(item.v).toBe(ASK_WIRE_VERSION);
		// exactly one meta, carrying the question context
		const metas = items.filter((i) => i.kind === "meta");
		expect(metas).toHaveLength(1);
		expect(metas[0]).toMatchObject({ qid: "db", i: 0, n: 1 });
		// options keep label/desc split; recommended is a flag, not a suffix
		expect(items.filter((i) => i.kind === "option").map((i) => i.label)).toEqual(["pg", "sqlite"]);
		expect(items.find((i) => i.kind === "option" && i.label === "sqlite")).toMatchObject({
			desc: "embedded",
		});
		expect(questionCall.options!.some((s) => s.includes("(Recommended)"))).toBe(false);
		// controls present, chat-removed never emitted
		expect(items.map((i) => i.kind).sort()).toEqual(["meta", "option", "option", "other"]);
		expect(items.some((i) => i.kind === "chat-removed")).toBe(false);
	});

	test("recommended option carries rec:true without touching the label", async () => {
		const q = {
			id: "r",
			question: "Restart?",
			options: [{ label: "Restart" }, { label: "Stay" }],
			recommended: 0,
		};
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("Restart") },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		const items = wireItems(calls[0]!.options!);
		expect(items.find((i) => i.label === "Restart")).toMatchObject({ kind: "option", rec: true });
		expect(items.find((i) => i.label === "Stay")!.rec).toBeUndefined();
		if (outcome.kind === "answers") {
			expect(outcome.results[0]!.selectedOptions).toEqual(["Restart"]);
		} else {
			throw new Error("expected answers");
		}
	});

	test("review dialog: summary is display-only; revise-q + submit + revise-all are the options", async () => {
		const qs = [
			{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }] },
			{ id: "b", question: "B?", options: [{ label: "p" }], multi: true },
		];
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select", title: "A?" }, reply: pickOption("x") },
			{ expect: { kind: "select", title: "B?" }, reply: pickDone() },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, qs, undefined);
		expect(outcome.kind).toBe("answers");
		const review = calls.find((c) => c.title === "Review your answers")!;
		const items = wireItems(review.options!);
		expect(items.map((i) => i.kind)).toEqual(["meta", "revise-q", "revise-q", "submit", "revise-all"]);
		expect(items.filter((i) => i.kind === "meta")).toHaveLength(1);
		// the current answers travel in revise-q descs for display only
		expect(items[1]).toMatchObject({ q: 0, qid: "a" });
		expect(items[1]!.desc).toContain("x");
		expect(items[2]).toMatchObject({ q: 1, qid: "b" });
	});

	test("duplicate labels stay unambiguous and map by exact match", async () => {
		const q = {
			id: "g",
			question: "Which?",
			options: [{ label: "foo" }, { label: "foo" }],
		};
		let replied: string | undefined;
		const pickSecondFoo = (_title: string, options: string[] | undefined) => {
			const s = pickNthOption("foo", 1)(_title, options);
			replied = s;
			return s;
		};
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickSecondFoo }, // the SECOND row
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		const emitted = calls[0]!.options!;
		expect(new Set(emitted).size).toBe(emitted.length);
		// wire invariant (§2.1): every emitted string is valid v1-JSON —
		// no string-suffix dedup may break parseability (throws on failure).
		const items = wireItems(emitted);
		const foos = items.filter((i) => i.kind === "option" && i.label === "foo");
		expect(foos).toHaveLength(2);
		// in-object differentiator: first copy untouched, second carries dup
		expect(foos[0]!.dup).toBeUndefined();
		expect(foos[1]!.dup).toBe(2);
		// the reply is the exact emitted string of the SECOND duplicate row,
		// so the driver resolves it positionally to the second action.
		expect(replied).toBe(emitted[2]);
		expect(tryParseWireItem(replied!)?.dup).toBe(2);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "g",
					question: "Which?",
					options: ["foo", "foo"],
					multi: false,
					selectedOptions: ["foo"],
				},
			],
		});
	});

	test("long desc/preview travel intact through the wire strings (R5 unit half)", async () => {
		const longDesc = "d".repeat(20000);
		const longPreview = "p".repeat(20000);
		const q = {
			id: "big",
			question: "Q?",
			options: [{ label: "a", description: longDesc, preview: longPreview }, { label: "b" }],
		};
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("a") },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		const items = wireItems(calls[0]!.options!);
		expect(items.find((i) => i.label === "a")).toMatchObject({ desc: longDesc, preview: longPreview });
		expect(outcome.kind).toBe("answers");
	});

	test("tryParseWireItem: plain strings fail, unknown kinds parse (degrade, don't crash)", () => {
		expect(tryParseWireItem("Submit answers")).toBeUndefined();
		expect(tryParseWireItem("not json {")).toBeUndefined();
		expect(tryParseWireItem(JSON.stringify({ v: 2, kind: "option", label: "x" }))).toBeUndefined();
		const future = tryParseWireItem(JSON.stringify({ v: 1, kind: "fancy-new", label: "X" }));
		expect(future?.label).toBe("X");
	});
});

describe("rpcFallbackAsk behavior", () => {
	test("single select flows through review and submit", async () => {
		const { ui, left } = scriptedUi([
			{ expect: { kind: "select", title: "Which db?" }, reply: pickOption("sqlite") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickSubmit() },
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

	test("Type a response captures free-form input", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input", title: "Which db?" }, reply: "postgres 17" },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome.kind).toBe("answers");
		if (outcome.kind === "answers") {
			expect(outcome.results[0]!.customInput).toBe("postgres 17");
		}
	});

	test("free-form chat-style text arrives as customInput (ZAVOD-30 scenario 6)", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input" }, reply: "обсудим в чате, созвонимся" },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome.kind).toBe("answers");
		if (outcome.kind === "answers") {
			expect(outcome.results[0]!.customInput).toBe("обсудим в чате, созвонимся");
			expect(outcome.results[0]!.selectedOptions).toEqual([]);
		}
	});

	test("single: picking an option after free-form replaces it (OMP parity, scenario 5)", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input" }, reply: "first thought" },
			{ expect: { kind: "select" }, reply: pickReviseQ(0) },
			{ expect: { kind: "select" }, reply: pickOption("pg") },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "db",
					question: "Which db?",
					options: ["pg", "sqlite"],
					multi: false,
					selectedOptions: ["pg"],
				},
			],
		});
	});

	test("multi-select re-opens with checkmarks in meta until Done", async () => {
		const q = { id: "s", question: "Scopes?", options: [{ label: "api" }, { label: "ui" }], multi: true };
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("api") }, // toggle on -> re-open
			{ expect: { kind: "select" }, reply: pickOption("api") }, // toggle off -> re-open
			{ expect: { kind: "select" }, reply: pickOption("api") }, // on again
			{ expect: { kind: "select" }, reply: pickDone() },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		expect(calls.filter((c) => c.kind === "select")).toHaveLength(5);
		// the re-opened dialogs carry the current checks in meta.checked
		const metas = calls.slice(0, 4).map((c) => wireItems(c.options!).find((i) => i.kind === "meta")!);
		expect(metas[0]!.checked).toBeUndefined();
		expect(metas[1]!.checked).toEqual(["api"]);
		expect(metas[2]!.checked).toBeUndefined();
		expect(metas[3]!.checked).toEqual(["api"]);
		expect(outcome).toEqual({
			kind: "answers",
			results: [{ id: "s", question: "Scopes?", options: ["api", "ui"], multi: true, selectedOptions: ["api"] }],
		});
	});

	test("multi + Type a response keeps checkbox selections (OMP parity)", async () => {
		const q = { id: "s", question: "Scopes?", options: [{ label: "api" }, { label: "ui" }], multi: true };
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("api") }, // toggle on -> re-open
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input" }, reply: "also web" },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "s",
					question: "Scopes?",
					options: ["api", "ui"],
					multi: true,
					selectedOptions: ["api"],
					customInput: "also web",
				},
			],
		});
	});

	test("multi: toggling after free-form complements it (OMP parity, scenario 5)", async () => {
		const q = { id: "s", question: "Scopes?", options: [{ label: "api" }, { label: "ui" }], multi: true };
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("api") },
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input" }, reply: "also web" },
			{ expect: { kind: "select" }, reply: pickReviseQ(0) },
			{ expect: { kind: "select" }, reply: pickOption("ui") },
			{ expect: { kind: "select" }, reply: pickDone() },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, [q], undefined);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "s",
					question: "Scopes?",
					options: ["api", "ui"],
					multi: true,
					selectedOptions: ["api", "ui"],
					customInput: "also web",
				},
			],
		});
	});

	test("no chat control is emitted on any dialog", async () => {
		const qs = [
			{ id: "a", question: "A?", options: [{ label: "x" }] },
			{ id: "b", question: "B?", options: [{ label: "y" }], multi: true },
		];
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("x") },
			{ expect: { kind: "select" }, reply: pickDone() },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		await rpcFallbackAsk(ui, qs, undefined);
		for (const call of calls) {
			if (call.kind !== "select") continue;
			for (const raw of call.options!) {
				const item = tryParseWireItem(raw);
				expect(item).toBeDefined();
				expect(item!.kind).not.toBe("chat-removed");
				expect(item!.label).not.toContain("Chat about this");
			}
		}
	});

	test("a client returning unknown strings never selects anything and stops after 3 (scenario 9)", async () => {
		const qs = [
			{ id: "first", question: "First?", options: [{ label: "a" }] },
			{ id: "second", question: "Second?", options: [{ label: "b" }] },
		];
		const { ui, calls } = scriptedUi([
			{ expect: { kind: "select", title: "First?" }, reply: pickOption("a") },
			{ expect: { kind: "select", title: "Second?" }, reply: "garbage-1" },
			{ expect: { kind: "select", title: "Second?" }, reply: "garbage-2" },
			{ expect: { kind: "select", title: "Second?" }, reply: "garbage-3" },
		]);
		const outcome = await rpcFallbackAsk(ui, qs, undefined);
		expect(calls).toHaveLength(4);
		// cancellation carries the answered question for the transcript
		expect(outcome).toEqual({
			kind: "cancelled",
			partialResults: [
				{ id: "first", question: "First?", options: ["a"], multi: false, selectedOptions: ["a"] },
				{ id: "second", question: "Second?", options: ["b"], multi: false, selectedOptions: [] },
			],
		});
	});

	test("unknown strings on review also stop after 3, keeping partial answers", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOption("pg") },
			{ expect: { kind: "select" }, reply: "junk-1" },
			{ expect: { kind: "select" }, reply: "junk-2" },
			{ expect: { kind: "select" }, reply: "junk-3" },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome.kind).toBe("cancelled");
		if (outcome.kind === "cancelled") {
			expect(outcome.partialResults).toEqual([
				{
					id: "db",
					question: "Which db?",
					options: ["pg", "sqlite"],
					multi: false,
					selectedOptions: ["pg"],
				},
			]);
		}
	});

	test("dismissed dialog is a cancellation with partial answers, never a selection", async () => {
		const { ui } = scriptedUi([{ expect: { kind: "select" }, reply: undefined }]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({
			kind: "cancelled",
			partialResults: [
				{ id: "db", question: "Which db?", options: ["pg", "sqlite"], multi: false, selectedOptions: [] },
			],
		});
	});

	test("revise-q re-asks only that question and preserves the rest", async () => {
		const qs = [
			{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }] },
			{ id: "b", question: "B?", options: [{ label: "p" }, { label: "q" }] },
		];
		const { ui, calls, left } = scriptedUi([
			{ expect: { kind: "select", title: "A?" }, reply: pickOption("x") },
			{ expect: { kind: "select", title: "B?" }, reply: pickOption("p") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickReviseQ(0) },
			// only A? is re-asked here: any B? select would be an unexpected call
			{ expect: { kind: "select", title: "A?" }, reply: pickOption("y") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, qs, undefined);
		expect(left()).toHaveLength(0);
		expect(calls.filter((c) => c.title === "B?")).toHaveLength(1);
		if (outcome.kind === "answers") {
			expect(outcome.results.map((r) => r.selectedOptions)).toEqual([["y"], ["p"]]);
		} else {
			throw new Error("expected answers");
		}
	});

	test("revise-all re-asks every question, preserving answers until changed", async () => {
		const qs = [
			{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y" }] },
			{ id: "b", question: "B?", options: [{ label: "p" }, { label: "q" }] },
		];
		const { ui, left } = scriptedUi([
			{ expect: { kind: "select", title: "A?" }, reply: pickOption("x") },
			{ expect: { kind: "select", title: "B?" }, reply: pickOption("p") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickReviseAll() },
			{ expect: { kind: "select", title: "A?" }, reply: pickOption("y") },
			{ expect: { kind: "select", title: "B?" }, reply: pickOption("q") },
			{ expect: { kind: "select", title: "Review your answers" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, qs, undefined);
		expect(left()).toHaveLength(0);
		if (outcome.kind === "answers") {
			expect(outcome.results.map((r) => r.selectedOptions)).toEqual([["y"], ["q"]]);
		} else {
			throw new Error("expected answers");
		}
	});

	test("empty free-form input re-asks instead of answering", async () => {
		const { ui } = scriptedUi([
			{ expect: { kind: "select" }, reply: pickOther() },
			{ expect: { kind: "input" }, reply: "   " },
			{ expect: { kind: "select" }, reply: pickOption("pg") },
			{ expect: { kind: "select" }, reply: pickSubmit() },
		]);
		const outcome = await rpcFallbackAsk(ui, oneQuestion, undefined);
		expect(outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "db",
					question: "Which db?",
					options: ["pg", "sqlite"],
					multi: false,
					selectedOptions: ["pg"],
				},
			],
		});
	});
});
