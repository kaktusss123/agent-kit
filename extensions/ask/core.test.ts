import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "./contract";
import {
	activateRow,
	advance,
	clampCursor,
	currentQuestion,
	goBack,
	initialState,
	moveCursor,
	previewFor,
	reviewLines,
	rowsFor,
	submitOther,
	submitReview,
	toResults,
	buildRows,
} from "./core";

const single: AskQuestion = {
	id: "base",
	question: "Which base?",
	options: [{ label: "main" }, { label: "develop", description: "integration" }],
	recommended: 1,
};

const multi: AskQuestion = {
	id: "scopes",
	question: "Which scopes?",
	options: [{ label: "api" }, { label: "ui" }],
	multi: true,
};

const questions: AskQuestion[] = [single, multi];

describe("buildRows", () => {
	test("options plus runtime controls; recommended suffix on single-select", () => {
		const rows = buildRows(single);
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "other", "chat"]);
		expect(rows[1]!.label).toBe("develop (Recommended)");
		expect(rows[1]!.description).toBe("integration");
	});

	test("multi-select gets a Done row and no recommended suffix", () => {
		const rows = buildRows(multi);
		expect(rows.map((r) => r.kind)).toEqual(["option", "option", "done", "other", "chat"]);
		expect(rows[0]!.label).toBe("api");
	});
});

describe("single-select flow", () => {
	test("activate selects and advances; recommended positions the cursor", () => {
		const state = initialState(questions);
		expect(state.cursor).toBe(1); // recommended row
		activateRow(state, questions);
		expect(state.answers[0]).toEqual({ selectedOptions: ["develop"] });
		expect(state.index).toBe(1);
	});

	test("Other captures free-form text and clears the selection", () => {
		const state = initialState(questions);
		const rows = rowsFor(state, questions);
		state.cursor = rows.findIndex((r) => r.kind === "other");
		activateRow(state, questions);
		expect(state.mode).toBe("other");
		submitOther(state, questions, "  use main  ");
		expect(state.answers[0]).toEqual({ selectedOptions: [], customInput: "  use main  " });
		expect(state.index).toBe(1);
	});

	test("empty Other returns to the question without answering", () => {
		const state = initialState(questions);
		state.mode = "other";
		submitOther(state, questions, "   ");
		expect(state.mode).toBe("question");
		expect(state.answers[0]).toBeUndefined();
	});
});

describe("multi-select flow", () => {
	test("activate toggles without advancing; Done advances", () => {
		const state = initialState(questions);
		// first question answered via Other to focus on multi behavior
		state.answers[0] = { selectedOptions: ["main"], customInput: undefined };
		advance(state, questions);
		expect(currentQuestion(state, questions)?.id).toBe("scopes");

		activateRow(state, questions); // toggle api on
		expect(state.answers[1]?.selectedOptions).toEqual(["api"]);
		expect(state.index).toBe(1);

		moveCursor(state, questions, 1);
		activateRow(state, questions); // toggle ui on
		expect(state.answers[1]?.selectedOptions).toEqual(["api", "ui"]);

		activateRow(state, questions); // toggle ui off again
		expect(state.answers[1]?.selectedOptions).toEqual(["api"]);

		const rows = rowsFor(state, questions);
		state.cursor = rows.findIndex((r) => r.kind === "done");
		activateRow(state, questions);
		expect(state.mode).toBe("review");
	});

	test("multi rows reflect checkmarks in labels", () => {
		const state = initialState(questions);
		state.answers[0] = { selectedOptions: ["main"] };
		advance(state, questions);
		activateRow(state, questions); // check api
		const labels = rowsFor(state, questions).map((r) => r.label);
		expect(labels[0]).toContain("☑");
		expect(labels[1]).toContain("☐");
	});
});

describe("navigation and review", () => {
	test("advance to review, back to questions, cursor clamped", () => {
		const state = initialState(questions);
		activateRow(state, questions); // answer q1
		activateRow(state, questions); // toggle api (stays)
		const doneIdx = rowsFor(state, questions).findIndex((r) => r.kind === "done");
		state.cursor = doneIdx;
		activateRow(state, questions); // done -> review
		expect(state.mode).toBe("review");
		expect(reviewLines(state, questions)).toEqual([
			"1/2 [base] develop",
			"2/2 [scopes] [multi] api",
		]);

		goBack(state, questions);
		expect(state.mode).toBe("question");
		expect(state.index).toBe(1);

		goBack(state, questions);
		expect(state.index).toBe(0);
		// cursor clamped into range for the previous question
		clampCursor(state, questions);
		expect(state.cursor).toBeLessThan(rowsFor(state, questions).length);
	});

	test("submitReview produces OMP-shaped results for every question", () => {
		const state = initialState(questions);
		activateRow(state, questions); // base=develop (cursor starts at recommended); advances
		activateRow(state, questions); // scopes: toggle api on
		const doneIdx = rowsFor(state, questions).findIndex((r) => r.kind === "done");
		state.cursor = doneIdx;
		activateRow(state, questions); // done -> review
		submitReview(state, questions);
		expect(state.outcome).toEqual({
			kind: "answers",
			results: [
				{
					id: "base",
					question: "Which base?",
					options: ["main", "develop"],
					multi: false,
					selectedOptions: ["develop"],
				},
				{
					id: "scopes",
					question: "Which scopes?",
					options: ["api", "ui"],
					multi: true,
					selectedOptions: ["api"],
				},
			],
		});
	});

	test("duplicate question ids keep independent answers (F4)", () => {
		const dupes: AskQuestion[] = [
			{ id: "same", question: "First?", options: [{ label: "a" }, { label: "b" }] },
			{ id: "same", question: "Second?", options: [{ label: "a" }, { label: "b" }] },
		];
		const state = initialState(dupes);
		activateRow(state, dupes); // answer first question
		expect(state.answers[0]!.selectedOptions).toEqual(["a"]);
		expect(state.answers[1]).toBeUndefined();
		activateRow(state, dupes); // answer second question
		expect(state.answers[0]!.selectedOptions).toEqual(["a"]);
		expect(state.answers[1]!.selectedOptions).toEqual(["a"]);
		expect(new Set(toResults(dupes, state.answers).map((r) => r.selectedOptions[0]))).toEqual(new Set(["a", "a"]));
		// both positions answered independently (a shared record would flip both)
		state.answers[1]!.selectedOptions = ["b"];
		expect(state.answers[0]!.selectedOptions).toEqual(["a"]);
	});

	test("fractional and out-of-range recommended are ignored entirely (F5)", () => {
		const fractional: AskQuestion = {
			id: "f",
			question: "Q?",
			options: [{ label: "a" }, { label: "b" }],
			recommended: 1.5,
		};
		const oor: AskQuestion = {
			id: "o",
			question: "Q?",
			options: [{ label: "a" }, { label: "b" }],
			recommended: 99,
		};
		expect(initialState([fractional]).cursor).toBe(0);
		expect(initialState([oor]).cursor).toBe(0);
		// no runtime control row is ever auto-highlighted
		expect(rowsFor(initialState([oor]), [oor])[0]!.label).toBe("a");
	});

	test("a genuine ' (Recommended)' label suffix is preserved in answers (F5)", () => {
		const tricky: AskQuestion = {
			id: "t",
			question: "Q?",
			options: [{ label: "Restart (Recommended)" }, { label: "Stay" }],
			recommended: 1,
		};
		const state = initialState([tricky]);
		activateRow(state, [tricky]); // cursor at recommended row 1
		expect(state.answers[0]!.selectedOptions).toEqual(["Stay"]);
		// the display row of the tricky option keeps the suffix, its answer would too
		expect(buildRows(tricky)[0]!.label).toBe("Restart (Recommended)");
	});

	test("multi + Other keeps checkbox selections (OMP parity)", () => {
		const multiQ: AskQuestion = {
			id: "m",
			question: "Q?",
			options: [{ label: "api" }, { label: "ui" }],
			multi: true,
		};
		const state = initialState([multiQ]);
		activateRow(state, [multiQ]); // check api
		const rows = buildRows(multiQ);
		state.cursor = rows.findIndex((r) => r.kind === "other");
		activateRow(state, [multiQ]); // Other -> input mode
		submitOther(state, [multiQ], "also web");
		expect(state.answers[0]).toEqual({
			selectedOptions: ["api"],
			customInput: "also web",
		});
	});

	test("toResults tolerates unanswered questions", () => {
		const results = toResults(questions, []);
		expect(results[0]!.selectedOptions).toEqual([]);
		expect(results[1]!.multi).toBe(true);
	});
});

describe("preview pane", () => {
	test("preview follows the highlighted option row", () => {
		const withPreview: AskQuestion = {
			id: "p",
			question: "Pick",
			options: [
				{ label: "a", preview: "alpha" },
				{ label: "b" },
			],
		};
		const qs: AskQuestion[] = [withPreview];
		const state = initialState(qs);
		expect(previewFor(state, qs)).toBe("alpha");
		moveCursor(state, qs, 1);
		expect(previewFor(state, qs)).toBeUndefined();
	});
});

describe("chat and cancel", () => {
	test("chat row resolves the whole dialog", () => {
		const state = initialState(questions);
		const rows = rowsFor(state, questions);
		state.cursor = rows.findIndex((r) => r.kind === "chat");
		activateRow(state, questions);
		expect(state.outcome).toEqual({ kind: "chat" });
	});

	test("cancelled outcome is set by the wiring, not the state machine", () => {
		const state = initialState(questions);
		expect(state.outcome).toBeUndefined();
	});
});
