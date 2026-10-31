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
	OTHER_OPTION_LABEL,
	type AskInput,
	type AskOutcome,
	type AskQuestion,
	type AskQuestionResult,
	findReservedOptionLabel,
	formatAskOutcomeText,
	normalizeAskArguments,
} from "./contract.ts";
import { AskSchema } from "./ask-schema.ts";
import {
	reviewLines,
	type QuestionAnswer,
	toResults,
} from "./core.ts";

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
			// continuing on uncertainty. Already-answered questions travel in
			// details.partialResults so the transcript can render them.
			if (outcome.kind === "cancelled") {
				const maybeAbort = (ctx as { abort?: () => void } | undefined)?.abort;
				if (typeof maybeAbort === "function") maybeAbort.call(ctx);
				return {
					content: [
						{ type: "text", text: "Error: ask was cancelled by the user; the current turn is aborted" },
					],
					details: askCancelledDetails(params as AskInput, outcome.partialResults),
					isError: true,
				};
			}
			// Tolerance for legacy senders: no current surface produces
			// kind: chat (ZAVOD-30 removed the control), but keep handling it.
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
		return askCancelledDetails(request, outcome.partialResults);
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

/**
 * Details for a cancelled ask: the abort flag, the asked questions, and the
 * answers collected so far (same shape as `results`) so the transcript can
 * render answered questions and mark the rest unanswered (ZAVOD-30 §2.5).
 */
export function askCancelledDetails(
	request: AskInput,
	partialResults?: AskQuestionResult[],
): Record<string, unknown> {
	return {
		cancelled: true,
		questions: request.questions.map((q) => q.question),
		...(partialResults !== undefined ? { partialResults } : {}),
	};
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

/**
 * JSON-aware wire dedup (ZAVOD-30 §2.1 wire invariant): ensures every
 * emitted option string is unique WITHOUT breaking JSON validity. The
 * first occurrence of each identical encoding is kept as-is; every later
 * duplicate gets an in-object `dup` differentiator before encoding, bumped
 * further while the encoding still collides with an already-used string.
 * Positional mapping (`actions[]`) is untouched — callers keep the same
 * order, only the item payloads change. Parsers ignore `dup` for display.
 */
export function disambiguateWireItems(items: AskWireItem[]): AskWireItem[] {
	const seen = new Set(items.map((item) => JSON.stringify(item)));
	if (seen.size === items.length) return items; // fast path: already unique
	const used = new Set<string>();
	const occurrence = new Map<string, number>();
	return items.map((item) => {
		const base = JSON.stringify(item);
		const k = (occurrence.get(base) ?? 0) + 1;
		occurrence.set(base, k);
		if (k === 1) {
			used.add(base);
			return item; // the first occurrence of each identical item keeps its encoding
		}
		// Later copies carry `dup` mirroring their occurrence number,
		// bumped further when that exact encoding already exists.
		let n = k;
		let candidate: AskWireItem = { ...item, dup: n };
		let encoded = JSON.stringify(candidate);
		while (used.has(encoded)) {
			n += 1;
			candidate = { ...item, dup: n };
			encoded = JSON.stringify(candidate);
		}
		used.add(encoded);
		return candidate;
	});
}

// ============================================================ wire format v2 (ZAVOD-30 §2.1)

/**
 * ask-v2 wire version. Every select option the fallback emits is a JSON
 * string of this shape; pi's RPC layer carries strings opaquely, so the
 * richness (label/desc/preview/rec/meta) travels inside the string. The
 * select TITLE stays human text (the question); the web renderer reads the
 * single `kind: meta` item for question context instead of showing it.
 * `"chat-removed"` is reserved and never emitted. Remote parsers must
 * degrade unknown `kind` values to a flat button instead of failing.
 *
 * Answers travel back as one of the emitted strings verbatim (or
 * `cancelled`); the driver maps the reply by exact string equality, so
 * uniqueness of the emitted strings is enforced with
 * `disambiguateWireItems` below (in-object `dup` differentiator — never a
 * string suffix, which would break JSON validity per the wire invariant).
 */
export const ASK_WIRE_VERSION = 1;

/** Option kinds on the ask-v2 wire. */
export type AskWireKind =
	| "option"
	| "other"
	| "done"
	| "chat-removed"
	| "submit"
	| "revise-all"
	| "revise-q"
	| "meta";

export interface AskWireItem {
	v: 1;
	kind: AskWireKind;
	label: string;
	desc?: string;
	preview?: string;
	rec?: true;
	/** revise-q only: question position. */
	q?: number;
	/** meta/revise-q only: question id ("review" for the review dialog). */
	qid?: string;
	/** meta only: question position (i) and total question count (n). */
	i?: number;
	n?: number;
	/** meta only. */
	header?: string;
	/** meta only. */
	multi?: true;
	/**
	 * PR1 extension, question-dialog meta only: raw labels currently
	 * selected, so the renderer can paint multi checkmarks across the
	 * stateless toggle re-opens. Extra-field tolerant parsers ignore it;
	 * omitted when nothing is selected.
	 */
	checked?: string[];
	/**
	 * Wire-collision differentiator (ZAVOD-30 §2.1 wire invariant): when two
	 * wire items would encode to the identical string, the later copies
	 * carry `dup: <occurrence number>` (2 for the second copy, 3 for the
	 * third, …) so every emitted string stays valid v1-JSON and remains
	 * parseable by `tryParseWireItem`. Parsers are tolerant to unknown
	 * fields and ignore it for display; the driver still resolves the reply
	 * positionally by exact string equality. Absent on the first occurrence
	 * and on naturally unique items.
	 */
	dup?: number;
}

export function encodeWireItem(item: AskWireItem): string {
	return JSON.stringify(item);
}

/**
 * Structural parse of one emitted wire string. Undefined for plain strings
 * (non-ask dialogs of other extensions) and garbage. Unknown `kind` values
 * are NOT rejected here — parsers degrade them to flat buttons.
 */
export function tryParseWireItem(raw: string): AskWireItem | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const item = parsed as Record<string, unknown>;
	if (item.v !== ASK_WIRE_VERSION) return undefined;
	if (typeof item.kind !== "string" || typeof item.label !== "string") return undefined;
	return item as unknown as AskWireItem;
}

/** Recommended is a display hint only: single-select with an in-range integer index. */
function isRecommendedOption(question: AskQuestion, optionIndex: number): boolean {
	return (
		!question.multi &&
		typeof question.recommended === "number" &&
		Number.isInteger(question.recommended) &&
		question.recommended === optionIndex
	);
}

type FallbackAction =
	| { type: "option"; optionIndex: number }
	| { type: "other" }
	| { type: "done" }
	| { type: "revise"; questionIndex: number }
	| { type: "revise-all" }
	| { type: "submit" };

interface FallbackDialog {
	title: string;
	options: string[];
	/** Positional: actions[i] resolves options[i]; undefined = unmapped (counts as unknown). */
	actions: Array<FallbackAction | undefined>;
}

function finalizeDialog(
	title: string,
	items: AskWireItem[],
	actions: Array<FallbackAction | undefined>,
): FallbackDialog {
	const options = disambiguateWireItems(items).map(encodeWireItem);
	return { title, options, actions };
}

/** One question dialog: meta + options + Other (+ Done for multi). */
function questionDialog(
	question: AskQuestion,
	answer: QuestionAnswer | undefined,
	index: number,
	total: number,
): FallbackDialog {
	const selected = answer?.selectedOptions ?? [];
	const meta: AskWireItem = {
		v: 1,
		kind: "meta",
		label: "ask-v2",
		qid: question.id,
		i: index,
		n: total,
		...(question.header !== undefined && question.header !== "" ? { header: question.header } : {}),
		...(question.multi ? { multi: true as const } : {}),
		...(selected.length > 0 ? { checked: [...selected] } : {}),
	};
	const items: AskWireItem[] = [meta];
	const actions: Array<FallbackAction | undefined> = [undefined];
	question.options.forEach((option, optionIndex) => {
		items.push({
			v: 1,
			kind: "option",
			label: option.label,
			...(option.description !== undefined ? { desc: option.description } : {}),
			...(option.preview !== undefined ? { preview: option.preview } : {}),
			...(isRecommendedOption(question, optionIndex) ? { rec: true as const } : {}),
		});
		actions.push({ type: "option", optionIndex });
	});
	if (question.multi) {
		items.push({ v: 1, kind: "done", label: "✓ Done selecting" });
		actions.push({ type: "done" });
	}
	items.push({ v: 1, kind: "other", label: OTHER_OPTION_LABEL });
	actions.push({ type: "other" });
	return finalizeDialog(question.question, items, actions);
}

/**
 * Review dialog v2: the answer summary is NOT selectable — it travels in
 * the revise-q `desc` fields for display only. Selectable rows are exactly
 * one revise-q per question, submit, and revise-all.
 */
function reviewDialog(
	questions: AskQuestion[],
	answers: ReadonlyArray<QuestionAnswer | undefined>,
): FallbackDialog {
	const summaries = reviewLines(
		{ index: 0, mode: "review", cursor: 0, answers: [...answers], otherText: "" },
		questions,
	);
	const items: AskWireItem[] = [
		{
			v: 1,
			kind: "meta",
			label: "ask-v2 review",
			qid: "review",
			i: questions.length,
			n: questions.length,
		},
	];
	const actions: Array<FallbackAction | undefined> = [undefined];
	questions.forEach((question, k) => {
		items.push({
			v: 1,
			kind: "revise-q",
			label: `Revise Q${k + 1}`,
			desc: summaries[k],
			q: k,
			qid: question.id,
		});
		actions.push({ type: "revise", questionIndex: k });
	});
	items.push({ v: 1, kind: "submit", label: "Submit answers" });
	actions.push({ type: "submit" });
	items.push({ v: 1, kind: "revise-all", label: "Revise answers" });
	actions.push({ type: "revise-all" });
	return finalizeDialog("Review your answers", items, actions);
}

/**
 * Degraded ask for hosts without a custom TUI surface (e.g. RPC mode): one
 * select dialog per question (re-opening on multi toggles), a text input for
 * free-form answers, and a final review step with per-question revise.
 * Behavior parity with the rich dialog is intentional; presentation is up to
 * the renderer reading the ask-v2 wire items. No Chat control exists on any
 * surface (ZAVOD-30 D7).
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
	// Every cancellation carries the answers collected so far (same shape as
	// results) so the transcript can render them (ZAVOD-30 §2.5).
	const cancelled = (): AskOutcome => ({
		kind: "cancelled",
		partialResults: toResults(questions, answers),
	});
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i]!;
		const result = await askOneFallback(ui, i, question, answers, writeAnswer, signal, questions.length);
		if (result === "cancelled") return cancelled();
	}
	// Review before submit.
	let unknownReviews = 0;
	while (true) {
		const dialog = reviewDialog(questions, answers);
		const choice = await ui.select(dialog.title, dialog.options, { signal });
		if (choice === undefined) return cancelled();
		const action = dialog.actions[dialog.options.indexOf(choice)];
		if (!action) {
			// A hostile/broken client returning unknown strings must not get an
			// infinite dialog loop; and it must never select anything either.
			if (++unknownReviews >= 3) return cancelled();
			continue;
		}
		unknownReviews = 0;
		if (action.type === "submit") {
			return { kind: "answers", results: toResults(questions, answers) };
		}
		if (action.type === "revise" || action.type === "revise-all") {
			// Addressed revise re-asks only that question; revise-all walks
			// every question from the start. Either way the other answers
			// are preserved; afterwards the dialog returns to review.
			const targets =
				action.type === "revise" ? [action.questionIndex] : questions.map((_, k) => k);
			let stop: AskOutcome | undefined;
			for (const k of targets) {
				const result = await askOneFallback(ui, k, questions[k]!, answers, writeAnswer, signal, questions.length);
				if (result === "cancelled") {
					stop = cancelled();
					break;
				}
			}
			if (stop) return stop;
			continue;
		}
		// "option"/"other"/"done" actions can never appear on a review
		// dialog; treat them as unknown (defensive, keeps the mapper total).
		if (++unknownReviews >= 3) return cancelled();
	}
}

async function askOneFallback(
	ui: FallbackUi,
	questionIndex: number,
	question: AskQuestion,
	answers: ReadonlyArray<QuestionAnswer | undefined>,
	writeAnswer: (index: number, answer: QuestionAnswer) => void,
	signal: AbortSignal | undefined,
	total: number,
): Promise<"answered" | "cancelled"> {
	let unknownAnswers = 0;
	while (true) {
		const answer = answers[questionIndex];
		const dialog = questionDialog(question, answer, questionIndex, total);
		const choice = await ui.select(dialog.title, dialog.options, { signal });
		if (choice === undefined) return "cancelled";
		const action = dialog.actions[dialog.options.indexOf(choice)];
		if (!action) {
			// A hostile/broken client returning unknown strings must not get an
			// infinite dialog loop; and it must never select anything either.
			if (++unknownAnswers >= 3) return "cancelled";
			continue;
		}
		unknownAnswers = 0;
		if (action.type === "other") {
			const text = await ui.input(dialog.title, undefined, { signal });
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
		if (action.type === "done") return "answered";
		if (action.type === "option") {
			// Raw option label by index: display badges/prefixes never leak in.
			const label = question.options[action.optionIndex]!.label;
			if (question.multi) {
				const current = new Set(answer?.selectedOptions ?? []);
				if (current.has(label)) current.delete(label);
				else current.add(label);
				// Toggle touches only the checkboxes (core parity): a
				// previously typed custom input survives toggling.
				writeAnswer(questionIndex, {
					selectedOptions: [...current],
					...(answer?.customInput !== undefined ? { customInput: answer.customInput } : {}),
				});
				continue; // re-open so the user can check more or pick Done
			}
			writeAnswer(questionIndex, { selectedOptions: [label] });
			return "answered";
		}
		// Review-only actions can never appear on a question dialog;
		// treat them as unknown (defensive, keeps the mapper total).
		if (++unknownAnswers >= 3) return "cancelled";
	}
}
