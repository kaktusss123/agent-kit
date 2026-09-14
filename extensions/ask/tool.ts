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
	findReservedOptionLabel,
	formatAskOutcomeText,
	normalizeAskArguments,
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
	/**
	 * Argument-repair shim (contract.ts): absorbs the malformed shapes models
	 * actually emit (option-level `recommended` flags, boolean/label
	 * recommendations, extra properties) before strict schema validation.
	 */
	prepareArguments(args: unknown): AskInput;
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
		prepareArguments: normalizeAskArguments,
		// One shared UI surface per session: run alone in the tool batch so
		// concurrent asks cannot clobber each other's dialogs.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.questions || params.questions.length === 0) {
				return askError("questions must not be empty");
			}
			// OMP reserved-label invariant, applied identically on the child
			// side (bridge-ask.ts): a model option colliding with a runtime
			// control would render duplicate rows and resolve wrong actions.
			const reserved = findReservedOptionLabel(params as AskInput);
			if (reserved) {
				return askError(
					`option label "${reserved}" collides with a runtime-added control; use a different label`,
				);
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
			// OMP parity: dismissing the question is a workflow cancellation --
			// the missing answer was material, so the turn stops instead of
			// continuing on uncertainty. "Chat about this" stays a normal
			// outcome handled above.
			if (outcome.kind === "cancelled") {
				const maybeAbort = (ctx as { abort?: () => void } | undefined)?.abort;
				if (typeof maybeAbort === "function") maybeAbort.call(ctx);
				return {
					content: [
						{ type: "text", text: "Error: ask was cancelled by the user; the current turn is aborted" },
					],
					details: { cancelled: true },
					isError: true,
				};
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

/**
 * RPC hosts select by display STRING, so two rows rendering the same string
 * would silently resolve the user's pick to the first of them (e.g. option
 * "Restart" with recommended badge vs a literal option "Restart
 * (Recommended)", or "foo — bar" vs label "foo" + description "bar").
 * Disambiguate the rendered strings: the first occurrence keeps its display,
 * every later duplicate gets an increasing " [n]" suffix, skipped when that
 * exact string already exists. Positional mapping to the rows is untouched,
 * and answers keep using the raw option labels.
 */
export function disambiguateDisplayLabels(labels: string[]): string[] {
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	if (counts.size === labels.length) return labels; // fast path: already unique

	const used = new Set(labels);
	const occurrence = new Map<string, number>();
	return labels.map((label) => {
		if ((counts.get(label) ?? 0) === 1) return label;
		const k = (occurrence.get(label) ?? 0) + 1;
		occurrence.set(label, k);
		if (k === 1) return label; // the first occurrence of each duplicated label keeps its display
		// later occurrences get a suffix mirroring their occurrence number,
		// bumped further when that exact string already exists
		let n = k;
		let candidate = `${label} [${n}]`;
		while (used.has(candidate)) {
			n += 1;
			candidate = `${label} [${n}]`;
		}
		used.add(candidate);
		return candidate;
	});
}

const OTHER_MARKER = "__ask_other__";
const DONE_MARKER = "__ask_done__";
const CHAT_MARKER = "__ask_chat__";

interface FallbackRow extends DialogRow {
	/**
	 * Identity used to resolve a picked display string back to an action:
	 * raw option label for "option" rows (answers must never see the display
	 * "(Recommended)" suffix), sentinel values for runtime controls.
	 */
	marker: string;
}

function fallbackRows(question: AskQuestion, answer: QuestionAnswer | undefined): FallbackRow[] {
	const rows = buildRows(question);
	const selected = new Set(answer?.selectedOptions ?? []);
	return rows.map((row) => {
		let marker: string;
		if (row.kind === "option") {
			marker = question.options[row.optionIndex!]!.label;
			if (question.multi) {
				row.label = (selected.has(marker) ? "☑ " : "☐ ") + row.label;
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
	// Answers by question position: duplicate ids must not share one record.
	const answers: Array<QuestionAnswer | undefined> = [];
	const writeAnswer = (index: number, answer: QuestionAnswer) => {
		answers[index] = answer;
	};
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i]!;
		const result = await askOneFallback(ui, i, question, answers, writeAnswer, signal);
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
			const result = await askOneFallback(ui, i, questions[i]!, answers, writeAnswer, signal);
			if (result === "cancelled") return { kind: "cancelled" };
			if (result === "chat") return { kind: "chat" };
		}
	}
}

async function askOneFallback(
	ui: FallbackUi,
	questionIndex: number,
	question: AskQuestion,
	answers: ReadonlyArray<QuestionAnswer | undefined>,
	writeAnswer: (index: number, answer: QuestionAnswer) => void,
	signal: AbortSignal | undefined,
): Promise<"answered" | "cancelled" | "chat"> {
	let unknownAnswers = 0;
	while (true) {
		const answer = answers[questionIndex];
		const rows = fallbackRows(question, answer);
		const options = disambiguateDisplayLabels(
			rows.map((row) => {
				const description = row.description ? ` — ${row.description}` : "";
				return `${row.label}${description}`;
			}),
		);
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
			// OMP parity: a custom answer complements multi-select checkboxes
			// but replaces a single selection.
			writeAnswer(questionIndex, {
				selectedOptions: question.multi ? (answer?.selectedOptions ?? []) : [],
				customInput: text.trimEnd(),
			});
			return "answered";
		}
		if (row.marker === DONE_MARKER) return "answered";
		// Option row: the marker is the raw option label (never a display
		// suffix), taken by index.
		const label = row.marker;
		if (question.multi) {
			const current = new Set(answer?.selectedOptions ?? []);
			if (current.has(label)) current.delete(label);
			else current.add(label);
			writeAnswer(questionIndex, { selectedOptions: [...current] });
			continue; // re-open so the user can check more or pick Done
		}
		writeAnswer(questionIndex, { selectedOptions: [label] });
		return "answered";
	}
}
