/**
 * Headless smoke test for the TUI dialog assembly: the AskDialog component is
 * rendering-driven by pi-tui primitives, but its behavior (key handling ->
 * core state machine -> outcome) can be exercised without a terminal using a
 * stub theme and real pi-tui key encodings.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { matchesKey, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AskDialog } from "./dialog.ts";
import type { AskOutcome, AskQuestion } from "./contract.ts";

// Raw terminal byte sequences (what handleInput receives in production).
const RAW = {
	down: "\x1b[B",
	up: "\x1b[A",
	left: "\x1b[D",
	right: "\x1b[C",
	enter: "\r",
	escape: "\x1b",
} as const;

const stubMdTheme = new Proxy({}, { get: () => (t: string) => t }) as unknown as MarkdownTheme;

const stubTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const questions: AskQuestion[] = [
	{
		id: "base",
		question: "Which base?",
		options: [{ label: "main" }, { label: "develop", description: "integration" }],
		recommended: 0,
	},
	{
		id: "scopes",
		question: "Scopes?",
		options: [
			{ label: "api", description: "HTTP layer", preview: "```ts\napp.get()\n```" },
			{ label: "ui" },
		],
		multi: true,
	},
];

function drive() {
	const outcomes: Array<AskOutcome | undefined> = [];
	const dialog = new AskDialog(questions, stubTheme, (o) => outcomes.push(o), {
		markdownTheme: () => stubMdTheme,
	});
	return { dialog, outcomes };
}

describe("AskDialog", () => {
	test("renders the question, options, and help without a terminal", () => {
		const { dialog } = drive();
		const lines = dialog.render(80).join("\n");
		expect(lines).toContain("Ask");
		expect(lines).toContain("[base]");
		expect(lines).toContain("Which base?");
		expect(lines).toContain("main (Recommended)");
		expect(lines).toContain("Type a response…");
		expect(lines).not.toContain("Chat about this");
		expect(lines).toContain("esc back");
		expect(lines).not.toContain("esc cancel");
	});

	test("the highlighted option's long description wraps and appears in full", () => {
		const longDescription =
			"Merges the release branch into main, runs the full verification suite, " +
			"publishes the tagged artifacts, and finally updates the changelog file";
		const qs: AskQuestion[] = [
			{
				id: "ship",
				question: "Ship it?",
				options: [{ label: "ship now", description: longDescription }, { label: "hold" }],
				recommended: 0,
			},
		];
		const dialog = new AskDialog(qs, stubTheme, () => {}, { markdownTheme: () => stubMdTheme });
		const lines = dialog.render(80);
		expect(lines.join("\n")).toContain("Merges the release"); // early fragment
		expect(lines.join("\n")).toContain("changelog file"); // late fragment past the wrap
	});

	test("a ~40-char recommended label renders unclipped at width 80", () => {
		const qs: AskQuestion[] = [
			{
				id: "fp",
				question: "What to do with the finding?",
				options: [{ label: "Suppress as FP in scanner" }, { label: "Fix now" }],
				recommended: 0, // rendered label: "Suppress as FP in scanner (Recommended)" (39 chars)
			},
		];
		const dialog = new AskDialog(qs, stubTheme, () => {}, { markdownTheme: () => stubMdTheme });
		const lines = dialog.render(80);
		expect(lines.some((line) => line.includes("Suppress as FP in scanner (Recommended)"))).toBe(true);
	});

	test("enter selects the highlighted option and advances to question 2", () => {
		const { dialog, outcomes } = drive();
		dialog.handleInput(RAW.down); // cursor: develop (single-select)
		dialog.handleInput(RAW.enter);
		expect(outcomes).toHaveLength(0);
		const lines = dialog.render(80).join("\n");
		expect(lines).toContain("[scopes]");
		expect(lines).toContain("Scopes?");
		// multi rows offer a Done control
		expect(lines).toContain("Done selecting");
	});

	test("esc on question 2 steps back to question 1 with answers preserved (E3)", () => {
		const { dialog, outcomes } = drive();
		dialog.handleInput(RAW.down); // cursor: develop (single-select)
		dialog.handleInput(RAW.enter); // answer base=develop -> question 2
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
		dialog.handleInput(RAW.escape); // back to base, answer kept
		const lines = dialog.render(80).join("\n");
		expect(lines).toContain("[base]");
		expect(outcomes).toHaveLength(0); // the turn is alive: nothing resolved
		// re-answering advances again; the preserved answer is still develop
		dialog.handleInput(RAW.enter);
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
	});

	test("esc on the first question is a no-op with a hint, never an abort (E3)", () => {
		const { dialog, outcomes } = drive();
		dialog.handleInput(RAW.escape);
		expect(outcomes).toHaveLength(0);
		const lines = dialog.render(80).join("\n");
		expect(lines).toContain("[base]"); // still on question 1
		expect(lines).toContain("Already at the first question");
		// the dialog still works after the no-op hint
		dialog.handleInput(RAW.enter);
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
		expect(outcomes).toHaveLength(0);
	});

	test("esc on review goes back to the questions (E3)", () => {
		const { dialog, outcomes } = drive();
		dialog.handleInput(RAW.enter); // base: main -> scopes
		dialog.handleInput(RAW.enter); // scopes: toggle api on
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.enter); // Done -> review
		expect(dialog.render(80).join("\n")).toContain("Review your answers");
		dialog.handleInput(RAW.escape); // back to questions, nothing resolved
		expect(outcomes).toHaveLength(0);
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
	});

	test("abort outcome carries the answers collected so far (partialResults)", () => {
		const outcomes: Array<AskOutcome | undefined> = [];
		const dialog = new AskDialog(questions, stubTheme, (o) => outcomes.push(o), {
			markdownTheme: () => stubMdTheme,
		});
		dialog.handleInput(RAW.enter); // base: main -> scopes
		const aborted = dialog.cancelledOutcome();
		expect(aborted).toEqual({
			kind: "cancelled",
			partialResults: [
				{
					id: "base",
					question: "Which base?",
					options: ["main", "develop"],
					multi: false,
					selectedOptions: ["main"],
				},
				{
					id: "scopes",
					question: "Scopes?",
					options: ["api", "ui"],
					multi: true,
					selectedOptions: [],
				},
			],
		});
		expect(outcomes).toHaveLength(0); // the dialog itself is still alive
	});

	test("Type a response captures free-form text via the embedded input", () => {
		const { dialog, outcomes } = drive();
		const enter = RAW.enter;
		// navigate to the free-form row: rows are [main, develop, Type a response…],
		// cursor starts at recommended row 0 -> two downs reach the free-form action
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.down);
		dialog.handleInput(enter); // activate Type a response…
		expect(dialog.render(80).join("\n")).toContain("> ");
		for (const ch of "use develop") {
			dialog.handleInput(ch);
		}
		dialog.handleInput(enter); // submit
		expect(outcomes).toHaveLength(0);
		// after submit the dialog advanced to question 2
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
	});

	test("escape from free-form input returns to the option picker", () => {
		const { dialog } = drive();
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.enter); // activate Type a response…
		expect(dialog.render(80).join("\n")).toContain("> ");
		dialog.handleInput(RAW.escape);
		const lines = dialog.render(80).join("\n");
		expect(lines).toContain("Which base?");
		expect(lines).toContain("Type a response…");
		expect(lines).not.toContain("enter submit · esc back");
	});

	test("multi select: space-free toggling via enter, review, submit", () => {
		const { dialog, outcomes } = drive();
		const enter = RAW.enter;
		dialog.handleInput(enter); // base: main (recommended, cursor 0) -> question 2
		dialog.handleInput(enter); // scopes: toggle api on
		const rendered = dialog.render(80).join("\n");
		expect(rendered).toContain("☑ api");
		// navigate to Done (api, ui, done) and submit
		dialog.handleInput(RAW.down);
		dialog.handleInput(RAW.down);
		dialog.handleInput(enter);
		expect(dialog.render(80).join("\n")).toContain("Review your answers");
		dialog.handleInput(enter); // submit
		expect(outcomes).toEqual([
			{
				kind: "answers",
				results: [
					{
						id: "base",
						question: "Which base?",
						options: ["main", "develop"],
						multi: false,
						selectedOptions: ["main"],
					},
					{
						id: "scopes",
						question: "Scopes?",
						options: ["api", "ui"],
						multi: true,
						selectedOptions: ["api"],
					},
				],
			},
		]);
	});

	test("left/right navigation preserves answers", () => {
		const { dialog } = drive();
		dialog.handleInput(RAW.enter); // answer base -> scopes
		dialog.handleInput(RAW.left); // back to base
		expect(dialog.render(80).join("\n")).toContain("[base]");
		// the recommended answer is preserved (re-select main advances again)
		dialog.handleInput(RAW.enter);
		expect(dialog.render(80).join("\n")).toContain("[scopes]");
	});

	test("no chat row exists anywhere in the dialog", () => {
		const { dialog, outcomes } = drive();
		expect(dialog.render(80).join("\n")).not.toContain("Chat about this");
		// walk every row and activate it: no activation resolves a chat outcome
		for (let i = 0; i < 4; i++) {
			const probe = drive();
			for (let k = 0; k < i; k++) probe.dialog.handleInput(RAW.down);
			probe.dialog.handleInput(RAW.enter);
			for (const outcome of probe.outcomes) {
				expect(outcome).not.toEqual({ kind: "chat" });
			}
		}
		expect(outcomes).toHaveLength(0);
	});

	test("raw key encodings match what handleInput dispatches on", () => {
		expect(matchesKey(RAW.enter, "enter")).toBe(true);
		expect(matchesKey(RAW.escape, "escape")).toBe(true);
		expect(matchesKey(RAW.down, "down")).toBe(true);
		expect(matchesKey(RAW.left, "left")).toBe(true);
	});
});
