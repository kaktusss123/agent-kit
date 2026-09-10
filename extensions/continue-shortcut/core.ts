/**
 * Pure decision core for the continue shortcut.
 *
 * Ported from oh-my-pi's `.`/`c` continue shortcut (TUI input controller,
 * packages/coding-agent/src/modes/controllers/input-controller.ts): submitting
 * a bare "." or "c" resumes the agent with a hidden agent-authored continue
 * directive instead of a visible user turn, so the model continues prior intent
 * rather than second-guessing it.
 *
 * No pi imports here; everything is decided from the raw input event fields.
 */

export const CONTINUE_SHORTCUT_CUSTOM_TYPE = "continue-shortcut";

/** What the input wiring should do with a submitted text. */
export type ContinueDecision =
	/** Swallow the input and queue the hidden continue directive. */
	| "trigger"
	/** Swallow the input without any effect (OMP parity: no-op mid-stream). */
	| "ignore"
	/** Let pi process the submission normally. */
	| "pass-through";

export interface ContinueInputEvent {
	text: string;
	hasImages: boolean;
	/** pi sets "steer"/"followUp" when the agent is (or becomes) busy; undefined when idle. */
	streamingBehavior?: "steer" | "followUp";
}

/**
 * Decide how to route a submitted input.
 *
 * Matching rules (OMP parity):
 * - exact standalone "." or "c" after trimming; case matters (`C` is prose);
 * - anything longer (".", "..", "c.", ".c", "continue") is normal prose.
 *
 * Deviations from OMP, both deliberate:
 * - submissions carrying images pass through untouched (OMP would silently
 *   drop the images and still continue; losing an attachment is worse).
 */
export function decideContinueShortcut(event: ContinueInputEvent): ContinueDecision {
	if (event.hasImages) return "pass-through";
	const text = event.text.trim();
	if (text !== "." && text !== "c") return "pass-through";
	// Only matching text reaches the guards: real prose must steer mid-stream
	// exactly as before. An explicit mid-stream "steer" submission of "."/"c"
	// is a no-op, matching OMP where the shortcut only fires while idle.
	if (event.streamingBehavior === "steer") return "ignore";
	return "trigger";
}
