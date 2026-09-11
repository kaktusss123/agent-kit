/**
 * Classification of a finished agent run from pi's agent_end messages.
 *
 * pi does not put an error flag on AgentEndEvent; the outcome is recovered
 * from the last assistant message's stopReason ("stop" | "length" |
 * "toolUse" | "error" | "aborted" | "pending" | "deferred") and errorMessage.
 * Structurally typed so it stays independent from pi's package layout.
 */

export type RunOutcome =
	| { status: "completed"; response?: string }
	| { status: "failed"; error?: string; response?: string }
	| { status: "aborted" };

/** Maximum kept length for user query / assistant response previews. */
export const MAX_TEXT_CODEPOINTS = 200;

interface AssistantLike {
	role: string;
	stopReason?: string;
	errorMessage?: string;
	content: unknown;
}

/** Truncate to at most `max` Unicode code points without splitting surrogates. */
export function truncateCodePoints(text: string, max: number = MAX_TEXT_CODEPOINTS): string {
	const points = Array.from(text);
	if (points.length <= max) return text;
	return points.slice(0, max).join("") + "…";
}

/** Join text parts of a message content value (string or content array). */
function joinedText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Walk backwards to the last assistant message and classify the run.
 * No assistant message at all (e.g. aborted before the first response)
 * classifies as completed with no response — there was no failure to report.
 */
export function classifyRunOutcome(messages: readonly unknown[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as AssistantLike | undefined;
		if (message?.role !== "assistant") continue;

		const text = joinedText(message.content);
		if (message.stopReason === "aborted") return { status: "aborted" };
		if (message.stopReason === "error") {
			return {
				status: "failed",
				error: message.errorMessage,
				response: text.length > 0 ? text : message.errorMessage,
			};
		}
		return { status: "completed", response: text.length > 0 ? text : undefined };
	}
	return { status: "completed" };
}
