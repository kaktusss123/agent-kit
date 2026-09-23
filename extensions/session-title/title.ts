/**
 * Pure helpers for session-title: title prompt construction, response
 * extraction/sanitization, and reading the saved "cheap" model class.
 *
 * The title is derived only from the user's first message; everything here is
 * deterministic so the LLM call itself stays in index.ts.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hard cap for a generated title, in code points (tab titles must stay short). */
export const TITLE_MAX_CODE_POINTS = 30;

/** System prompt for the title model. The reply language follows the user's message. */
export const TITLE_SYSTEM_PROMPT = [
	"You generate short session titles for a coding agent.",
	"Given the user's first message, reply with a 2-4 word title that captures the task's essence.",
	"Rules:",
	"- Reply in the same language as the user's message.",
	"- 2 to 4 words, never more: the most distinctive proper nouns or tech names plus the action, not a full sentence.",
	"- Prefer concrete identifiers (service, tech, component names) over generic verbs like \"fix\" or \"update\".",
	"- No surrounding quotes, no trailing punctuation, no prefixes like \"Task:\" or \"Re:\".",
	"- Describe the goal, not greetings or pleasantries.",
	"Good titles: \"Kuber-nagibator refactor\", \"Trino + S3\", \"Web-SQL ключ\".",
	"Reply with the title only.",
].join("\n");

/** User-turn prompt wrapping the first message. */
export function buildTitlePrompt(userPrompt: string): string {
	return `First message of the session:\n\n<first-message>\n${userPrompt}\n</first-message>\n\nReply with the session title only.`;
}

/** Strip pure code-fence lines (``` or ```lang) from a candidate list. */
function dropFenceLines(lines: string[]): string[] {
	const filtered = lines.filter((line) => !/^`{3,}/.test(line));
	return filtered.length > 0 ? filtered : lines;
}

/**
 * Extract and sanitize a title from a model response: first non-empty line,
 * stripped of code fences, quotes and wrapping punctuation, whitespace
 * collapsed, hard-capped at TITLE_MAX_CODE_POINTS (backing off to the last
 * space so the cut does not end mid-word). Returns undefined when nothing
 * usable remains.
 */
export function sanitizeTitle(raw: string): string | undefined {
	const nonEmpty = raw
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.filter((candidate) => candidate.length > 0);
	if (nonEmpty.length === 0) return undefined;

	let line = dropFenceLines(nonEmpty)[0];

	// Strip markdown code fences and backticks the model may wrap the title in.
	line = line.replace(/^`{1,3}/, "").replace(/`{1,3}$/, "").trim();
	// Strip one layer of wrapping quotes/dashes.
	line = line.replace(/^(?:["'«»“”‘’*_~+-]|\s)+/, "").replace(/(?:["'«»“”‘’*_~+-]|\s)+$/, "");
	// Drop a single trailing sentence period (other punctuation is kept).
	line = line.replace(/[.。]$/, "").trim();

	const codePoints = Array.from(line);
	if (codePoints.length > TITLE_MAX_CODE_POINTS) {
		// Hard-cut to the cap, then back off to the last space so the cut does not
		// end mid-word; a line with no spaces keeps the hard cut.
		line = codePoints.slice(0, TITLE_MAX_CODE_POINTS).join("");
		const lastSpace = line.lastIndexOf(" ");
		if (lastSpace > 0) line = line.slice(0, lastSpace);
	}
	const truncated = line.trim();
	return truncated.length > 0 ? truncated : undefined;
}

/** Default model-classes.json location, mirroring the model-classes extension. */
export function modelClassesFile(env: Record<string, string | undefined> = process.env): string {
	return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "model-classes.json");
}

/**
 * Read the saved "cheap" class canonical id (`<provider>/<modelId>`) from
 * model-classes.json. Returns undefined when the file is missing, unparsable,
 * or has no cheap class — callers fall back to the active session model.
 */
export function readCheapModelClass(file: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const cheap = (parsed as Record<string, unknown>)["cheap"];
		if (typeof cheap !== "object" || cheap === null) return undefined;
		const model = (cheap as Record<string, unknown>)["model"];
		if (typeof model !== "string") return undefined;
		const slash = model.indexOf("/");
		return slash > 0 && slash < model.length - 1 ? model : undefined;
	} catch {
		return undefined;
	}
}
