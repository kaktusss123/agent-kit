/**
 * Canonical `ask` contract — the single role-neutral definition of the tool
 * that both Main (extensions/ask) and subagent children (the subagents
 * bridge) share.
 *
 * The model always sees exactly one tool named `ask` with this schema,
 * regardless of whether it runs as Main (human answers through the local UI)
 * or as a subagent (the runtime routes the request to the controller/Main).
 * Nothing here mentions parents, transports, TUIs, or control planes.
 *
 * This module stays free of pi/typebox imports so pure unit tests can use it
 * directly (the typebox twin used by tool registration lives in
 * ask-schema.ts; see envelope.ts / envelope-schema.ts for the same pattern).
 */

// ==================================================================== types

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	/** Stable identifier used in multi-question results. */
	id: string;
	question: string;
	/** Optional short display chip used by rich multi-question UIs. */
	header?: string;
	options: AskOption[];
	/** Allow selecting multiple options. Default: false. */
	multi?: boolean;
	/** Zero-based recommended/default option index. UI hint only. */
	recommended?: number;
}

export interface AskInput {
	questions: AskQuestion[];
}

/** Answer to one question (mirrors the OMP-compatible result shape). */
export interface AskQuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

/**
 * Structured `ask` outcome: answers, a cancel, or a legacy chat redirect.
 *
 * `kind: "chat"` is never produced by any current surface (ZAVOD-30 removed
 * the Chat control everywhere); the variant stays in the type so receivers
 * (tool execute, subagents bridge) tolerate it if one ever arrives.
 */
export type AskOutcome =
	| { kind: "answers"; results: AskQuestionResult[] }
	| { kind: "chat" }
	| { kind: "cancelled"; partialResults?: AskQuestionResult[] };

// ============================================================ reserved labels

export const OTHER_OPTION_LABEL = "Type a response…";
/**
 * Legacy Chat control label. Never emitted by any surface since ZAVOD-30;
 * kept exported so receivers stay tolerant to it. NOT reserved: a model
 * option may now legitimately use this text (no runtime row collides).
 */
export const CHAT_OPTION_LABEL = "Chat about this";
export const NEXT_OPTION_LABEL = "Next →";

/** Labels the runtime adds itself; models must not send them as options. */
export const RESERVED_OPTION_LABELS: ReadonlySet<string> = new Set([
	OTHER_OPTION_LABEL,
	NEXT_OPTION_LABEL,
]);

// ============================================================== descriptions

/** Role-neutral tool description: identical for Main and subagents. */
export const ASK_TOOL_DESCRIPTION = [
	"Request missing information or a decision when it cannot be safely determined from the available context.",
	"Use it only when the missing answer materially affects how to proceed.",
	"Group related questions when practical and provide concise, distinct options with useful tradeoff descriptions.",
	"The runtime automatically adds a free-form response action — never include it yourself.",
].join(" ");

/** Role-neutral guideline bullets appended to the system prompt while active. */
export const ASK_TOOL_GUIDELINES = [
	"Use ask when a material decision cannot be resolved from the available context.",
	"Default to action: exhaust code, configs, docs, and history first; if several options are acceptable, pick the most conservative one, proceed, and state the choice.",
	"Ask with 2-5 concise, distinct options; put explanatory tradeoffs in descriptions, not labels.",
];

// ============================================================= validation

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isAskOption(value: unknown): value is AskOption {
	if (!isPlainObject(value)) return false;
	if (typeof value.label !== "string") return false;
	const description = value.description;
	if (description !== undefined && typeof description !== "string") return false;
	const preview = value.preview;
	if (preview !== undefined && typeof preview !== "string") return false;
	return true;
}

function isAskQuestion(value: unknown): value is AskQuestion {
	if (!isPlainObject(value)) return false;
	if (typeof value.id !== "string") return false;
	if (typeof value.question !== "string") return false;
	if (!Array.isArray(value.options) || !value.options.every(isAskOption)) return false;
	if (value.header !== undefined && typeof value.header !== "string") return false;
	if (value.multi !== undefined && typeof value.multi !== "boolean") return false;
	if (value.recommended !== undefined && typeof value.recommended !== "number") return false;
	return true;
}

/**
 * Structural validation of a parsed payload (transport twin of the typebox
 * schema). Lenient about extra fields; strict about the fields the runtime
 * relies on. Returns undefined for anything unusable — callers fail closed.
 */
export function validateAskInput(value: unknown): AskInput | undefined {
	if (!isPlainObject(value)) return undefined;
	const questions = value.questions;
	if (!Array.isArray(questions) || questions.length === 0) return undefined;
	if (!questions.every(isAskQuestion)) return undefined;
	return { questions: questions as AskQuestion[] };
}

// ======================================================== argument repair

/**
 * Repair the argument shapes models actually emit before the strict typebox
 * schema sees them (wired as `prepareArguments` on both registration sites,
 * so it runs before validation and execute — the same compatibility-shim
 * pattern as pi's own edit tool). The public schema stays strict; this shim
 * absorbs the noise:
 * - `recommended: true` embedded in individual options instead of a zero-based
 *   index on the question (the observed real-world failure mode);
 * - question-level `recommended` given as a boolean or an option label;
 * - unknown extra properties at any level (the model-facing twin of the
 *   lenient transport validation above).
 * Anything unrepairable is passed through unchanged so the strict schema
 * still produces a precise validation error — only cosmetic noise is dropped,
 * never required structure added.
 */
export function normalizeAskArguments(args: unknown): AskInput {
	// Return type is pi's prepareArguments contract: "the object you want
	// validated". Payloads that cannot be repaired are returned unchanged so
	// the strict schema produces the precise error instead of a mangled call.
	if (!isPlainObject(args) || !Array.isArray(args.questions)) return args as AskInput;
	return { questions: args.questions.map(normalizeAskQuestionArg) } as AskInput;
}

function normalizeAskQuestionArg(raw: unknown): unknown {
	if (!isPlainObject(raw) || !Array.isArray(raw.options)) return raw;
	const options: unknown[] = [];
	let flaggedIndex: number | undefined;
	raw.options.forEach((rawOption, index) => {
		if (!isPlainObject(rawOption)) {
			options.push(rawOption);
			return;
		}
		const option: Record<string, unknown> = {};
		// Recognized fields keep their raw value: a wrong-typed value must reach
		// the strict schema so it rejects the call with a precise error, instead
		// of this shim silently degrading semantics (e.g. dropping a non-boolean
		// `multi` would turn a multi-select question into single-select).
		if (rawOption.label !== undefined) option.label = rawOption.label;
		if (rawOption.description !== undefined) option.description = rawOption.description;
		if (rawOption.preview !== undefined) option.preview = rawOption.preview;
		if (rawOption.recommended === true && flaggedIndex === undefined) flaggedIndex = index;
		options.push(option);
	});
	const question: Record<string, unknown> = {};
	// Same preservation rule as options: recognized fields pass through
	// untouched (wrong-typed values are rejected by the schema, never dropped).
	if (raw.id !== undefined) question.id = raw.id;
	if (raw.question !== undefined) question.question = raw.question;
	if (raw.header !== undefined) question.header = raw.header;
	question.options = options;
	if (raw.multi !== undefined) question.multi = raw.multi;
	// An explicit question-level `recommended` key wins over embedded flags;
	// flags apply only when the question carries no recommendation signal.
	if (raw.recommended !== undefined) {
		const verdict = repairRecommended(raw.recommended, options);
		if (verdict === "keep") question.recommended = raw.recommended; // schema rejects precisely
		else if (typeof verdict === "number") question.recommended = verdict;
		// "drop" → omit: explicit no-recommendation or unreferencable `true`
	} else if (flaggedIndex !== undefined) {
		question.recommended = flaggedIndex;
	}
	return question;
}

/**
 * Question-level `recommended` verdict: the repaired index, `"drop"` for an
 * explicit no-recommendation value, or `"keep"` — preserve the raw value so
 * the strict schema rejects the call instead of the shim hiding the problem.
 */
function repairRecommended(raw: unknown, options: unknown[]): number | "keep" | "drop" {
	if (typeof raw === "number") return raw; // already canonical (out-of-range never matches a row)
	if (raw === true) return options.length > 0 ? 0 : "drop";
	if (raw === false) return "drop"; // explicit no-recommendation sentinel
	if (typeof raw === "string") {
		const exact = options.findIndex((o) => isPlainObject(o) && o.label === raw);
		if (exact !== -1) return exact;
		const needle = raw.trim().toLowerCase();
		const loose = options.findIndex(
			(o) =>
				isPlainObject(o) && typeof o.label === "string" && o.label.trim().toLowerCase() === needle,
		);
		if (loose !== -1) return loose;
	}
	return "keep"; // unmatchable label or non-scalar: let the schema reject it
}

/** Parse + validate a serialized request (the child -> controller wire form). */
export function parseAskRequest(raw: string | undefined): AskInput | undefined {
	if (raw === undefined || raw.length === 0) return undefined;
	try {
		return validateAskInput(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/**
 * OMP reserved-label invariant: the runtime adds its own "Other" and
 * "Next →" rows, so a model-supplied option with one of those labels
 * would collide with a runtime control (duplicate rows, wrong action
 * resolved). Returns the first offending label, if any. Applied
 * identically to Main and child executions.
 */
export function findReservedOptionLabel(request: AskInput): string | undefined {
	for (const question of request.questions) {
		for (const option of question.options) {
			if (RESERVED_OPTION_LABELS.has(option.label)) return option.label;
		}
	}
	return undefined;
}

// ================================================================ formatting

/** Compact one-line rendering for status views and snapshots. */
export function formatAskRequestFlat(request: AskInput): string {
	return request.questions
		.map((q) => {
			const labels = q.options.map((o) => o.label).join(" | ");
			const multi = q.multi ? " [multi]" : "";
			return `${q.id}: ${q.question} (${labels})${multi}`;
		})
		.join(" ;; ");
}

/** Lossless rendering for model delivery: the exact structured request. */
export function formatAskRequestJson(request: AskInput): string {
	return JSON.stringify(request, null, 2);
}

// ============================================================ result formats

function formatQuestionResult(result: AskQuestionResult): string {
	const suffix = result.customInput !== undefined
		? `: "${result.customInput.replace(/\n/g, " ")}"`
		: result.selectedOptions.length > 0
			? result.multi
				? `: [${result.selectedOptions.join(", ")}]`
				: `: ${result.selectedOptions[0]}`
			: ": (no answer)";
	return `${result.id}${suffix}`;
}

/**
 * Human-readable answer text returned to the calling model (OMP-compatible
 * shape): single question flattened, multiple questions one per line.
 *
 * Note: a user-dismissed ask is NOT formatted here — Main-side execute
 * aborts the turn instead (OMP parity); this branch only keeps the mapper
 * total.
 */
export function formatAskOutcomeText(outcome: AskOutcome): string {
	switch (outcome.kind) {
		case "chat":
			return "User chose to chat about this instead of answering. Discuss the topic with them; the question was not resolved.";
		case "cancelled":
			return "User dismissed the question without answering.";
		case "answers": {
			if (outcome.results.length === 1) {
				const r = outcome.results[0]!;
				const parts: string[] = [];
				if (r.selectedOptions.length > 0) {
					parts.push(
						r.multi
							? `User selected: ${r.selectedOptions.join(", ")}`
							: `User selected: ${r.selectedOptions[0]}`,
					);
				}
				if (r.customInput !== undefined) {
					parts.push(
						r.customInput.includes("\n")
							? `User provided custom input:\n${r.customInput}`
							: `User provided custom input: ${r.customInput}`,
					);
				}
				return parts.length > 0 ? parts.join("\n") : "User did not select any options";
			}
			return `User answers:\n${outcome.results.map(formatQuestionResult).join("\n")}`;
		}
	}
}
