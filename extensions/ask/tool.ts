/**
 * Main-side `ask` tool builder — the interactive-host implementation of the
 * canonical ask contract.
 *
 * The model-facing definition (name, schema, description, result format) is
 * identical to the subagent bridge's; the only difference is the injected
 * backend, which is the whole environment seam (SPEC §5):
 * - interactive TUI  -> rich custom dialog (wired in index.ts via dialog.ts)
 * - RPC (no custom UI) -> per-question select/input fallback (rpcFallbackAsk)
 * - headless/no UI    -> fail closed: the backend reports `unavailable` and
 *   the tool returns an explicit error instead of pretending someone answered.
 *
 * No pi imports: unit tests exercise the builder and the fallback with fakes.
 */
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_GUIDELINES,
	type AskInput,
	type AskOutcome,
	type AskQuestion,
	formatAskOutcomeText,
} from "./contract";
import { AskSchema } from "./ask-schema";
import {
	buildRows,
	type DialogRow,
	reviewLines,
	type QuestionAnswer,
	toResults,
} from "./core";

/** Minimal UI the RPC fallback needs (a subset of pi's ExtensionUIContext). */
export interface FallbackUi {
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	input(
		title: string,
		placeholder: string | undefined,
		opts?: { signal?: AbortSignal },
	): Promise<string | undefined>;
}

/**
 * Environment backend: produce the outcome of the ask. Reports
 * `{ unavailable }` (fail closed) when no working human-input backend exists.
 * Receives the tool-execute context (pi's ExtensionContext) — UI surfaces are
 * per-call, so the backend cannot be built once at registration time.
 */
export type AskBackend = (
	questions: AskInput,
	signal: AbortSignal | undefined,
	ctx: unknown,
) => Promise<AskOutcome | { unavailable: string }>;

export interface AskToolDefinition {
	name: "ask";
	label: string;
	description: string;
	promptGuidelines: string[];
	parameters: typeof AskSchema;
	executionMode: "sequential";
	execute(
		toolCallId: string,
		params: AskInput,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<AskToolResult>;
}

export interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export function buildAskTool(backend: AskBackend): AskToolDefinition {
	return {
		name: "ask",
		label: "Ask",
		description: ASK_TOOL_DESCRIPTION,
		promptGuidelines: [...ASK_TOOL_GUIDELINES],
		parameters: AskSchema,
		// One shared UI surface per session: run alone in the tool batch so
		// concurrent asks cannot clobber each other's dialogs.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.questions || params.questions.length === 0) {
				return askError("questions must not be empty");
			}
			let outcome: AskOutcome | { unavailable: string };
			try {
				outcome = await backend(params as AskInput, signal, ctx);
			} catch (e) {
				return askError(e instanceof Error ? e.message : String(e));
			}
			if ("unavailable" in outcome) {
				return askError(outcome.unavailable);
			}
			return {
				content: [{ type: "text", text: formatAskOutcomeText(outcome) }],
				details: askDetails(params as AskInput, outcome),
			};
		},
	};
}

/** OMP-shaped structured details for the transcript renderer and /tree. */
export function askDetails(request: AskInput, outcome: AskOutcome): Record<string, unknown> {
	if (outcome.kind === "chat") {
		return { chatRedirect: true, questions: request.questions.map((q) => q.question) };
	}
	if (outcome.kind === "cancelled") {
		return { cancelled: true, questions: request.questions.map((q) => q.question) };
	}
	const results = outcome.results;
	if (results.length === 1) {
		const r = results[0]!;
		return {
			question: r.question,
			options: r.options,
			multi: r.multi,
			selectedOptions: r.selectedOptions,
			...(r.customInput !== undefined ? { customInput: r.customInput } : {}),
		};
	}
	return { results };
}

function askError(message: string): AskToolResult {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { error: message },
		isError: true,
	};
}

// ============================================================ RPC fallback

const OTHER_MARKER = "__ask_other__";
const DONE_MARKER = "__ask_done__";
const CHAT_MARKER = "__ask_chat__";

const RECOMMENDED_SUFFIX = " (Recommended)";

function stripRecommended(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

interface FallbackRow extends DialogRow {
	marker: string;
}

function fallbackRows(question: AskQuestion, answer: QuestionAnswer | undefined): FallbackRow[] {
	const rows = buildRows(question);
	const selected = new Set(answer?.selectedOptions ?? []);
	return rows.map((row) => {
		let marker: string;
		if (row.kind === "option") {
			const option = question.options[row.optionIndex!]!;
			marker = option.label;
			if (question.multi) {
				row.label = (selected.has(option.label) ? "☑ " : "☐ ") + row.label;
			}
		} else if (row.kind === "other") {
			marker = OTHER_MARKER;
		} else if (row.kind === "done") {
			marker = DONE_MARKER;
		} else {
			marker = CHAT_MARKER;
		}
		return { ...row, marker };
	});
}

/**
 * Degraded ask for hosts without a custom TUI surface (e.g. RPC mode): one
 * select dialog per question (re-opening on multi toggles), a text input for
 * "Other", and a final review step. Behavior parity with the rich dialog is
 * intentional; presentation is necessarily simpler.
 */
export async function rpcFallbackAsk(
	ui: FallbackUi,
	questions: AskQuestion[],
	signal: AbortSignal | undefined,
): Promise<AskOutcome> {
	const answers: Record<string, QuestionAnswer> = {};
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i]!;
		const result = await askOneFallback(ui, question, answers, signal);
		if (result === "cancelled") return { kind: "cancelled" };
		if (result === "chat") return { kind: "chat" };
	}
	// Review before submit.
	while (true) {
		const state = {
			index: 0,
			mode: "review" as const,
			cursor: 0,
			answers,
			otherText: "",
		};
		const summary = reviewLines(state, questions);
		const choice = await ui.select(
			"Review your answers",
			[...summary, "Submit answers", "Revise answers", "Chat about this"],
			{ signal },
		);
		if (choice === undefined) return { kind: "cancelled" };
		if (choice === "Submit answers") {
			return { kind: "answers", results: toResults(questions, answers) };
		}
		if (choice === "Chat about this") return { kind: "chat" };
		// Revise from the beginning; existing answers are preserved.
		for (let i = 0; i < questions.length; i++) {
			const result = await askOneFallback(ui, questions[i]!, answers, signal);
			if (result === "cancelled") return { kind: "cancelled" };
			if (result === "chat") return { kind: "chat" };
		}
	}
}

async function askOneFallback(
	ui: FallbackUi,
	question: AskQuestion,
	answers: Record<string, QuestionAnswer>,
	signal: AbortSignal | undefined,
): Promise<"answered" | "cancelled" | "chat"> {
	let unknownAnswers = 0;
	while (true) {
		const answer = answers[question.id];
		const rows = fallbackRows(question, answer);
		const options = rows.map((row) => {
			const description = row.description ? ` — ${row.description}` : "";
			return `${row.label}${description}`;
		});
		const choice = await ui.select(question.question, options, { signal });
		if (choice === undefined) return "cancelled";
		const index = options.indexOf(choice);
		const row = rows[index];
		if (!row) {
			// A hostile/broken client returning unknown strings must not get an
			// infinite dialog loop; and it must never select anything either.
			if (++unknownAnswers >= 3) return "cancelled";
			continue;
		}
		unknownAnswers = 0;
		if (row.marker === CHAT_MARKER) return "chat";
		if (row.marker === OTHER_MARKER) {
			const text = await ui.input(question.question, undefined, { signal });
			if (text === undefined) continue;
			const trimmed = text.trim();
			if (trimmed.length === 0) continue;
			answers[question.id] = { selectedOptions: [], customInput: text.trimEnd() };
			return "answered";
		}
		if (row.marker === DONE_MARKER) return "answered";
		// Option row.
		const label = stripRecommended(row.marker);
		if (question.multi) {
			const selected = answer?.selectedOptions ?? [];
			const current = new Set(selected);
			if (current.has(label)) current.delete(label);
			else current.add(label);
			answers[question.id] = { selectedOptions: [...current] };
			continue; // re-open so the user can check more or pick Done
		}
		answers[question.id] = { selectedOptions: [label] };
		return "answered";
	}
}
