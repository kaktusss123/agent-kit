/**
 * Headless smoke test for the TUI dialog assembly: the AskDialog component is
 * rendering-driven by pi-tui primitives, but its behavior (key handling ->
 * core state machine -> outcome) can be exercised without a terminal using a
 * stub theme and real pi-tui key encodings.
 */
import { describe, expect, test } from "bun:test";
import { matchesKey, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AskDialog } from "./dialog";
import type { AskOutcome, AskQuestion } from "./contract";

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
		expect(lines).toContain("Chat about this");
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

	test("esc cancels the whole dialog", () => {
		const { dialog, outcomes } = drive();
		dialog.handleInput(RAW.escape);
		expect(outcomes).toEqual([{ kind: "cancelled" }]);
	});

	test("Type a response captures free-form text via the embedded input", () => {
		const { dialog, outcomes } = drive();
		const enter = RAW.enter;
		// navigate to the free-form row: rows are [main, develop, Type a response…, Chat],
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

	test("left/right navigation preserves answers; chat row resolves", () => {
		const { dialog } = drive();
		dialog.handleInput(RAW.enter); // answer base -> scopes
		dialog.handleInput(RAW.left); // back to base
		expect(dialog.render(80).join("\n")).toContain("[base]");
		// the recommended answer is preserved (re-select main advances again)
		dialog.handleInput(RAW.enter);
		expect(dialog.render(80).join("\n")).toContain("[scopes]");

		const { dialog: d2, outcomes } = drive();
		d2.handleInput(RAW.down);
		d2.handleInput(RAW.down);
		d2.handleInput(RAW.down); // chat row (wraps are SelectList behavior)
		d2.handleInput(RAW.enter);
		expect(outcomes).toEqual([{ kind: "chat" }]);
	});

	test("raw key encodings match what handleInput dispatches on", () => {
		expect(matchesKey(RAW.enter, "enter")).toBe(true);
		expect(matchesKey(RAW.escape, "escape")).toBe(true);
		expect(matchesKey(RAW.down, "down")).toBe(true);
		expect(matchesKey(RAW.left, "left")).toBe(true);
	});
});
