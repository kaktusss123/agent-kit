/**
 * Todo reminder engine, ported from oh-my-pi's `session/todo-tracker.ts`.
 *
 * Pure decision logic: given todo phases and the assistant's final text, it
 * decides whether to nudge the agent. Message delivery is the caller's job
 * (`pi.sendMessage` in index.ts). The question heuristics detect an agent
 * that stopped to ask the user something in plain text — models do this
 * constantly regardless of whether a structured "ask" tool exists.
 */

import { type IncompletePhase, type TodoPhase, incompleteByPhase, isClosedTodo } from "./core.ts";

export interface ReminderEngineConfig {
	reminders: boolean;
	remindersMax: number;
	midRunNudges: boolean;
	/** Mutating tool calls without a todo touch before a mid-run nudge may fire. */
	midRunMutationThreshold: number;
	/** Max mid-run nudges per cycle (one cycle = one user prompt). */
	midRunMaxPerCycle: number;
	/** Tool names whose successful calls count as mutations. */
	mutatingTools: ReadonlySet<string>;
}

export const DEFAULT_REMINDER_CONFIG: Omit<ReminderEngineConfig, "mutatingTools"> = {
	reminders: true,
	remindersMax: 3,
	midRunNudges: true,
	midRunMutationThreshold: 12,
	midRunMaxPerCycle: 2,
};

// =============================================================================
// "Agent is asking the user a question" heuristics (#ported from OMP)
// =============================================================================

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
	/^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
	/^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
/**
 * A trailing question mark is the universal signal that a line is a question, but
 * the English word/pronoun gates above exist to filter incidental "?" out of prose
 * (e.g. a TypeScript `foo?: string` tail). Non-English text has no cheap word list,
 * yet any non-ASCII character in a "?"/"？"-terminated line reliably marks it as
 * genuine prose — treat it as a real user-directed question.
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
		NON_ASCII_TEXT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

/** Whether the assistant's final text ends with a question or a response cue. */
export function isAwaitingUserAnswer(assistantText: string): boolean {
	const text = assistantText.trim();
	if (!text) return false;
	const lastLine = text.split(/\r?\n/).at(-1)?.trim();
	return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}

// =============================================================================
// Engine
// =============================================================================

export class TodoReminderEngine {
	readonly #cfg: ReminderEngineConfig;
	#reminderCount = 0;
	#reminderAwaitingProgress = false;
	#mutationsSinceLastTouch = 0;
	#midRunNudgeCount = 0;

	constructor(cfg: ReminderEngineConfig) {
		this.#cfg = cfg;
	}

	/** Resets per-prompt reminder and mutation budgets. Call on each user prompt. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#reminderAwaitingProgress = false;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/** Records a finished tool result; must run before any async processing. */
	recordToolResult(toolName: string, isError: boolean | undefined): void {
		if (toolName === "todo") {
			this.#mutationsSinceLastTouch = 0;
		} else if (!isError && this.#cfg.mutatingTools.has(toolName)) {
			this.#mutationsSinceLastTouch++;
		}
		this.#reminderAwaitingProgress = false;
	}

	get awaitingProgress(): boolean {
		return this.#reminderAwaitingProgress;
	}

	/**
	 * Decide a stop-time reminder. Returns the incomplete phases, the attempt
	 * number, and the configured max when a reminder should be sent (and marks
	 * one as sent), or `null` when any guard holds: reminders disabled, budget
	 * exhausted, nothing open, a prior reminder still awaiting progress, or the
	 * agent stopping to ask the user a question.
	 */
	consumeStopReminder(
		phases: readonly TodoPhase[],
		assistantText: string,
	): { incomplete: IncompletePhase[]; attempt: number; max: number } | null {
		if (!this.#cfg.reminders) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return null;
		}
		if (this.#reminderAwaitingProgress) return null;
		if (this.#reminderCount >= this.#cfg.remindersMax) return null;

		const incomplete = incompleteByPhase(phases);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#reminderAwaitingProgress = false;
			return null;
		}
		if (isAwaitingUserAnswer(assistantText)) return null;

		this.#reminderCount++;
		this.#mutationsSinceLastTouch = 0;
		this.#reminderAwaitingProgress = true;
		return { incomplete, attempt: this.#reminderCount, max: this.#cfg.remindersMax };
	}

	/**
	 * Decide a hidden mid-run reconciliation nudge: fires after
	 * `midRunMutationThreshold` mutating tool calls without a todo touch, at
	 * most `midRunMaxPerCycle` times. Returns the open-task count or `null`.
	 */
	takeMidRunNudge(phases: readonly TodoPhase[]): number | null {
		if (!this.#cfg.midRunNudges) return null;
		if (this.#mutationsSinceLastTouch < this.#cfg.midRunMutationThreshold) return null;
		if (this.#midRunNudgeCount >= this.#cfg.midRunMaxPerCycle) return null;
		const incomplete = phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;
		this.#mutationsSinceLastTouch = 0;
		this.#midRunNudgeCount++;
		return incomplete.length;
	}
}

/** The `<system-reminder>` text for a stop-time todo reminder. */
export function buildStopReminderText(incomplete: IncompletePhase[], attempt: number, max: number): string {
	const phaseLines = incomplete.map(phase => {
		const taskLines = phase.tasks.map(task => "  - " + task.content);
		return ["- " + phase.name, ...taskLines].join("\n");
	});
	const todoList = phaseLines.join("\n");
	const count = incomplete.reduce((sum, phase) => sum + phase.tasks.length, 0);
	return (
		`<system-reminder>\n` +
		`You stopped with ${count} incomplete todo item(s):\n${todoList}\n\n` +
		`Please continue working on these tasks or mark them complete if finished.\n` +
		`(Reminder ${attempt}/${max})\n` +
		`</system-reminder>`
	);
}

/** Whether every todo is settled — the HUD has nothing left to track. */
export function allTodosClosed(phases: readonly TodoPhase[]): boolean {
	const tasks = phases.flatMap(phase => phase.tasks);
	return tasks.length > 0 && tasks.every(isClosedTodo);
}
