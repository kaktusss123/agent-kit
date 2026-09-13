/**
 * Live operator observability for long-running workspace_agent calls:
 * pure formatting of bounded child tool activity into the transient tool-call
 * progress view.
 *
 * Two responsibilities, both unit-testable without pi or child processes:
 * - summarizeToolActivity: distill a child `tool_execution_start` event into
 *   a bounded, conservative one-line summary. Only allow-listed scalar keys
 *   are ever extracted (command/path/pattern/query/...), whitespace is
 *   flattened, and the result is aggressively truncated. Whole argument
 *   blobs and tool output never pass through here.
 * - formatRunStatus: render one point-in-time view of a workspace run
 *   (identity, lifecycle state, elapsed/deadline, session, current tool,
 *   bounded recent activity) as compact plain text for onUpdate.
 *
 * This is status telemetry, not a log: every collection that flows through
 * this module stays hard-capped by its producer (controller/workspace layer).
 */
import type { ToolActivity } from "./types";
import { formatDuration } from "./delivery";

/**
 * Argument keys this module may surface, in priority order. Everything not
 * listed is omitted from the live view — a missing preview is preferred over
 * a leaked secret or an unbounded blob.
 */
const SUMMARY_KEYS = [
	"command",
	"pattern",
	"query",
	"file_path",
	"path",
	"url",
	"run_id",
	"op",
] as const;

/** Hard cap for a summary line (current view); recent entries get a shorter cap. */
const SUMMARY_MAX = 72;
const RECENT_SUMMARY_MAX = 48;

/**
 * Bounded one-line preview of a tool call's arguments. Returns undefined
 * when no allow-listed scalar can be extracted cleanly — never falls back to
 * serializing the input.
 */
export function summarizeToolActivity(name: string, args: unknown): string | undefined {
	void name; // the tool name is carried separately; only args are summarized here
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of SUMMARY_KEYS) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const flat = flattenOneLine(value);
		if (flat) return truncate(flat, SUMMARY_MAX);
	}
	return undefined;
}

/** Collapse control characters and whitespace runs into a single-line string. */
function flattenOneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One point-in-time snapshot of a workspace run, ready to format. */
export interface RunStatusView {
	runId: string;
	agentId: string;
	workspace: string;
	/** Workspace run state: running | waiting_input | settling | terminating. */
	state: string;
	/** Report recovery ladder position, shown only when step > 0. */
	ladder?: { step: number; max: number };
	elapsedMs: number;
	deadlineMsLeft?: number;
	pid?: number;
	model?: string;
	thinking?: string;
	sessionId?: string;
	sessionFile?: string;
	activeTool?: ToolActivity;
	recentActivity?: ToolActivity[];
	/** Clock used for all live durations (injected for deterministic tests). */
	now: number;
}

/**
 * Compact operator view of a running RepoOwner, rendered into the tool call
 * via onUpdate. Plain text, no ANSI, no JSON. Sections without data are
 * omitted — the view only ever states what the runtime actually knows.
 */
export function formatRunStatus(v: RunStatusView): string {
	const lines: string[] = [];
	const head = [`RepoOwner ${v.runId}`];
	lines.push(...head);
	lines.push("");

	const stateParts = [v.state, formatDuration(v.elapsedMs)];
	if (v.deadlineMsLeft !== undefined) stateParts.push(`deadline ${formatDuration(v.deadlineMsLeft)}`);
	if (v.ladder && v.ladder.step > 0) stateParts.push(`report recovery ${v.ladder.step}/${v.ladder.max}`);
	lines.push(stateParts.join(" · "));

	const agentParts = [v.agentId];
	if (v.pid !== undefined) agentParts.push(`pid ${v.pid}`);
	lines.push(`agent      ${agentParts.join(" · ")}`);
	lines.push(`workspace  ${v.workspace}`);
	const modelParts = [v.model, v.thinking].filter(Boolean);
	if (modelParts.length > 0) lines.push(`model      ${modelParts.join(" · ")}`);
	const session = v.sessionId ?? v.sessionFile;
	if (session) lines.push(`session    ${session}`);

	if (v.activeTool) {
		lines.push("");
		lines.push("current");
		const age = formatDuration(Math.max(0, v.now - v.activeTool.startedAt));
		const parts = [v.activeTool.name];
		if (v.activeTool.summary) parts.push(v.activeTool.summary);
		parts.push(age);
		lines.push(`  ${parts.join(" · ")}`);
	}

	if (v.recentActivity && v.recentActivity.length > 0) {
		lines.push("");
		lines.push("recent");
		for (const entry of v.recentActivity) {
			const parts = [entry.name];
			if (entry.summary) parts.push(truncate(entry.summary, RECENT_SUMMARY_MAX));
			lines.push(`  ${parts.join(" · ")}`);
		}
	}

	return lines.join("\n");
}
