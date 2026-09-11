/**
 * Pure state machine for the interactive ask dialog — no pi imports, so unit
 * tests exercise the exact logic the TUI dialog and the RPC fallback share:
 * row building, selection/toggling, question navigation, review, and the
 * final structured result.
 */
import {
	CHAT_OPTION_LABEL,
	OTHER_OPTION_LABEL,
	type AskInput,
	type AskOutcome,
	type AskQuestion,
	type AskQuestionResult,
} from "./contract";

// ==================================================================== rows

export type RowKind = "option" | "other" | "done" | "chat";

export interface DialogRow {
	kind: RowKind;
	/** Option index for kind === "option". */
	optionIndex?: number;
	label: string;
	description?: string;
}

const RECOMMENDED_SUFFIX = " (Recommended)";

/**
 * Rows for one question, in display order: options, then runtime controls.
 * Single-select marks the recommended option in the label (stripped again in
 * results); multi-select always offers "Done selecting". "Other" and "Chat
 * about this" are runtime-added — the model never sends them.
 */
export function buildRows(question: AskQuestion): DialogRow[] {
	const rows: DialogRow[] = question.options.map((option, optionIndex) => {
		const recommended =
			!question.multi &&
			question.recommended !== undefined &&
			question.recommended === optionIndex &&
			!option.label.endsWith(RECOMMENDED_SUFFIX);
		return {
			kind: "option" as const,
			optionIndex,
			label: recommended ? option.label + RECOMMENDED_SUFFIX : option.label,
			description: option.description,
		};
	});
	if (question.multi) {
		rows.push({ kind: "done", label: "✓ Done selecting" });
	}
	rows.push({ kind: "other", label: OTHER_OPTION_LABEL });
	rows.push({ kind: "chat", label: CHAT_OPTION_LABEL });
	return rows;
}

// ==================================================================== state

export interface QuestionAnswer {
	selectedOptions: string[];
	customInput?: string;
}

export type DialogMode = "question" | "other" | "review";

export interface DialogState {
	index: number;
	mode: DialogMode;
	cursor: number;
	/**
	 * Answers by question POSITION, not id: OMP keeps per-position state, and
	 * duplicate ids must not share one answer record.
	 */
	answers: Array<QuestionAnswer | undefined>;
	otherText: string;
	/** Set once the dialog resolves; the component passes it to done(). */
	outcome?: AskOutcome;
}

export function initialState(questions: AskQuestion[]): DialogState {
	return {
		index: 0,
		mode: "question",
		cursor: initialCursor(questions[0]),
		answers: [],
		otherText: "",
	};
}

/**
 * Recommended is a hint only: it positions the initial cursor and never
 * selects anything. Valid only as an integer option index — out-of-range or
 * fractional values are ignored entirely (OMP parity), so the cursor can
 * never land on a runtime control row.
 */
function initialCursor(question: AskQuestion | undefined): number {
	if (!question) return 0;
	const r = question.recommended;
	if (typeof r === "number" && Number.isInteger(r) && r >= 0 && r < question.options.length) {
		return r;
	}
	return 0;
}

function answerOf(state: DialogState, index: number): QuestionAnswer {
	let answer = state.answers[index];
	if (!answer) {
		answer = { selectedOptions: [] };
		state.answers[index] = answer;
	}
	return answer;
}

export function currentQuestion(state: DialogState, questions: AskQuestion[]): AskQuestion | undefined {
	return questions[state.index];
}

export function rowsFor(state: DialogState, questions: AskQuestion[]): DialogRow[] {
	const question = currentQuestion(state, questions);
	if (!question) return [];
	const rows = buildRows(question);
	if (question.multi) {
		// Reflect current checks in labels so re-renders show state.
		const selected = new Set(answerOf(state, state.index).selectedOptions);
		for (const row of rows) {
			if (row.kind === "option") {
				const option = question.options[row.optionIndex!]!;
				row.label = (selected.has(option.label) ? "☑ " : "☐ ") + row.label;
			}
		}
	}
	return rows;
}

/** Preview content of the currently highlighted option, if any. */
export function previewFor(state: DialogState, questions: AskQuestion[]): string | undefined {
	const question = currentQuestion(state, questions);
	if (!question) return undefined;
	const row = rowsFor(state, questions)[state.cursor];
	if (row?.kind !== "option") return undefined;
	return question.options[row.optionIndex!]?.preview;
}

// ================================================================ movement

export function clampCursor(state: DialogState, questions: AskQuestion[]): void {
	const rowCount = rowsFor(state, questions).length;
	state.cursor = Math.max(0, Math.min(state.cursor, Math.max(0, rowCount - 1)));
}

export function moveCursor(state: DialogState, questions: AskQuestion[], delta: number): void {
	if (state.mode !== "question") return;
	state.cursor += delta;
	clampCursor(state, questions);
}

/** Advance to the next question, or to review after the last one. */
export function advance(state: DialogState, questions: AskQuestion[]): void {
	if (state.index < questions.length - 1) {
		state.index += 1;
		state.mode = "question";
		state.cursor = initialCursor(questions[state.index]);
	} else {
		state.mode = "review";
	}
}

/** Go back: review -> last question, question i -> question i-1. */
export function goBack(state: DialogState, questions: AskQuestion[]): void {
	if (state.mode === "review") {
		state.mode = "question";
		return;
	}
	if (state.mode === "other") {
		state.mode = "question";
		return;
	}
	if (state.index > 0) {
		state.index -= 1;
		state.mode = "question";
		clampCursor(state, questions);
	}
}

// ================================================================ actions

/**
 * Activate the highlighted row: select (single), toggle (multi), or enter
 * one of the runtime controls. May resolve the dialog (chat) or advance.
 */
export function activateRow(state: DialogState, questions: AskQuestion[]): void {
	if (state.mode !== "question") return;
	const question = currentQuestion(state, questions);
	if (!question) return;
	const row = rowsFor(state, questions)[state.cursor];
	if (!row) return;
	if (row.kind === "chat") {
		state.outcome = { kind: "chat" };
		return;
	}
	if (row.kind === "other") {
		state.mode = "other";
		state.otherText = "";
		return;
	}
	if (row.kind === "done") {
		advance(state, questions);
		return;
	}
	const option = question.options[row.optionIndex!]!;
	const answer = answerOf(state, state.index);
	if (question.multi) {
		const i = answer.selectedOptions.indexOf(option.label);
		if (i >= 0) answer.selectedOptions.splice(i, 1);
		else answer.selectedOptions.push(option.label);
	} else {
		// The display row may carry a "(Recommended)" suffix; the answer is
		// always the raw option label, taken by index.
		answer.selectedOptions = [option.label];
		answer.customInput = undefined;
		advance(state, questions);
	}
}

/** Submit the free-form "Other" answer for the current question. */
export function submitOther(state: DialogState, questions: AskQuestion[], text: string): void {
	if (state.mode !== "other") return;
	const question = currentQuestion(state, questions);
	if (!question) return;
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		state.mode = "question";
		return;
	}
	const answer = answerOf(state, state.index);
	answer.customInput = text;
	// OMP parity: a custom answer complements multi-select checkboxes but
	// replaces a single selection.
	if (!question.multi) answer.selectedOptions = [];
	advance(state, questions);
}

/** Submit from the review screen (single-select questions must be answered). */
export function submitReview(state: DialogState, questions: AskQuestion[]): void {
	if (state.mode !== "review") return;
	state.outcome = { kind: "answers", results: toResults(questions, state.answers) };
}

// ================================================================== results

export function toResults(
	questions: AskQuestion[],
	answers: ReadonlyArray<QuestionAnswer | undefined>,
): AskQuestionResult[] {
	return questions.map((question, index) => {
		const answer = answers[index] ?? { selectedOptions: [] };
		return {
			id: question.id,
			question: question.question,
			options: question.options.map((option) => option.label),
			multi: question.multi ?? false,
			selectedOptions: answer.selectedOptions,
			...(answer.customInput !== undefined ? { customInput: answer.customInput } : {}),
		};
	});
}

// ================================================================== review

/** One line per question for the review screen. */
export function reviewLines(state: DialogState, questions: AskQuestion[]): string[] {
	return questions.map((question, i) => {
		const answer = state.answers[i];
		let answerText: string;
		if (answer?.customInput !== undefined) {
			answerText = `"${answer.customInput.replace(/\n/g, " ")}"`;
		} else if (answer && answer.selectedOptions.length > 0) {
			answerText = answer.selectedOptions.join(", ");
		} else {
			answerText = "(not answered)";
		}
		const multi = question.multi ? " [multi]" : "";
		return `${i + 1}/${questions.length} [${question.id}]${multi} ${answerText}`;
	});
}
