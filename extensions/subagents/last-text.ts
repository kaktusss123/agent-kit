/**
 * Automatic bounded projection of a child's last PUBLIC assistant text
 * (ZAVOD-39 UX revision): the single most recent completed assistant
 * message's `type=text` content, normalized and capped.
 *
 * This is a separate channel from `report_progress` (agent-authored
 * progress) and from RunHistory: it captures ordinary assistant speech the
 * model already produces, without any voluntary tool call. Thinking
 * content, tool calls, tool results, error/aborted/deferred messages and
 * delta streams never enter; only completed `message_end` events do. The
 * runtime assigns `updatedAt` at acceptance — the agent never supplies it.
 */
export interface LastAssistantText {
	/** Normalized public text: control chars replaced, whitespace folded, trimmed; max 512 UTF-16 code units. */
	text: string;
	/** Unix milliseconds assigned by the runtime at acceptance. */
	updatedAt: number;
}

/** Hard cap in UTF-16 code units (`String.length`). */
export const LAST_TEXT_MAX = 512;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Stop reasons whose messages are not completed public speech. */
const NON_PUBLIC_STOP_REASONS = new Set(["error", "aborted", "deferred", "pending"]);

/**
 * Extract the public text of a completed assistant `message_end` payload:
 * only `type=text` content blocks, joined in order. Returns undefined when
 * the message is absent/malformed, not assistant, error/aborted/deferred,
 * or carries no text blocks at all.
 */
export function publicAssistantText(message: unknown): string | undefined {
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const msg = message as { role?: unknown; stopReason?: unknown; content?: unknown };
	if (msg.role !== "assistant") return undefined;
	if (typeof msg.stopReason === "string" && NON_PUBLIC_STOP_REASONS.has(msg.stopReason)) return undefined;
	if (!Array.isArray(msg.content)) return undefined;
	const parts: string[] = [];
	for (const block of msg.content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n");
}

/**
 * Normalize: control characters → space, whitespace runs folded to one
 * space, trimmed, then capped at LAST_TEXT_MAX UTF-16 code units (the cap
 * runs AFTER normalization so it bounds the stored text, not the raw one).
 * Returns undefined for an empty result — an empty message never replaces
 * an accepted fragment.
 */
export function normalizeLastText(raw: string): string | undefined {
	const normalized = raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > LAST_TEXT_MAX ? normalized.slice(0, LAST_TEXT_MAX) : normalized;
}

/**
 * Validate a LastAssistantText-shaped value (persisted or foreign input);
 * malformed values return undefined so old/corrupt optional fields stay
 * harmless instead of leaking into live projections.
 */
export function validateLastAssistantText(value: unknown): LastAssistantText | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as { text?: unknown; updatedAt?: unknown };
	if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > LAST_TEXT_MAX) return undefined;
	if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt) || v.updatedAt < 0) return undefined;
	return { text: v.text, updatedAt: v.updatedAt };
}
