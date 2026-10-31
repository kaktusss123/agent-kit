/**
 * Live operator observability for long-running workspace-mode subagent spawns:
 * pure formatting of bounded child tool activity into the transient tool-call
 * progress view.
 *
 * Two responsibilities, both unit-testable without pi or child processes:
 * - summarizeToolActivity: distill a child `tool_execution_start` event into
 *   a bounded, conservative one-line summary. Only allow-listed scalar keys
 *   are ever extracted (command/path/pattern/query/...), whitespace is
 *   flattened, and the result is aggressively truncated. Whole argument
 *   blobs and tool output never pass through here. When the caller passes
 *   the child's workspace cwd, workspace-absolute paths and `cd <workspace>`
 *   prefixes are compacted to workspace-relative forms (home paths collapse
 *   to `~/...`) so the cap is spent on the actual command/file, not on the
 *   worktree path prefix. All matching is literal and pure string work; the
 *   formatted view stays workspace-aware via the run's own workspace line.
 * - formatRunStatus: render one point-in-time view of a workspace run
 *   (identity, lifecycle state, elapsed/deadline, workspace/model/stats meta,
 *   current tool, bounded recent activity) as compact plain text for onUpdate.
 *
 * This is status telemetry, not a log: every collection that flows through
 * this module stays hard-capped by its producer (controller/workspace layer).
 */
import { homedir } from "node:os";
import type { SessionStats, ToolActivity } from "./types.ts";
import { formatDuration, formatStatsBrief, formatProgress } from "./delivery.ts";
import type { Progress } from "./progress.ts";

/**
 * Tool-aware argument exposure policy: tool name -> the argument keys that
 * may be surfaced, in priority order. Tools not listed here get NO summary —
 * their arguments are never scanned. `url` is deliberately absent (signed
 * URLs, embedded tokens); a missing preview is always preferred over leaking
 * credentials into the operator view.
 */
const TOOL_SUMMARY_POLICY: Record<string, readonly string[]> = {
	bash: ["command"],
	powershell: ["command"],
	read: ["path", "file_path"],
	edit: ["path", "file_path"],
	write: ["path", "file_path"],
	grep: ["pattern", "path"],
	find: ["pattern", "path"],
	ls: ["path"],
	web_search: ["query"],
};

/** Hard cap for a summary line (current view); recent entries get a shorter cap. */
const SUMMARY_MAX = 72;
const RECENT_SUMMARY_MAX = 48;
/** Recent activity rows rendered under the active tool. */
const RECENT_MAX = 3;

/** Evaluated once; home-relative paths are collapsed to `~/...` summaries. */
const HOME = homedir();

/**
 * Bounded one-line preview of a tool call's arguments, extracted only for
 * tools with an explicit policy and only from that policy's keys. Unknown
 * tools and unknown arguments produce no summary — never a serialized blob.
 *
 * `workspace` (the child's cwd, i.e. the managed worktree) enables literal,
 * segment-boundary-safe compaction: workspace paths become relative, bare
 * workspace mentions become `.`, home paths become `~/...`, and a redundant
 * leading `cd <workspace> && ` is stripped. Without it the summary is
 * byte-identical to the plain flatten-and-truncate behavior.
 */
export function summarizeToolActivity(name: string, args: unknown, workspace?: string): string | undefined {
	const allowed = TOOL_SUMMARY_POLICY[name];
	if (!allowed) return undefined; // unknown tool: no summary, no scanning
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of allowed) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const flat = flattenOneLine(value);
		if (!flat) continue;
		return truncate(compactForSummary(key, flat, workspace), SUMMARY_MAX);
	}
	return undefined;
}

/** Per-key dispatch into the workspace-relative transforms (no-op without a workspace). */
function compactForSummary(key: string, flat: string, workspace?: string): string {
	if (!workspace) return flat; // back-compat: byte-identical to plain flatten
	if (key === "command") return compactCommand(flat, workspace);
	if (key === "path" || key === "file_path") return compactPath(flat, workspace);
	return flat; // pattern/query stay verbatim
}

/** Workspace-relative path; home-relative as fallback; never touches siblings. */
function compactPath(value: string, workspace: string): string {
	if (value === workspace) return ".";
	if (value.startsWith(workspace + "/")) {
		const rel = value.slice(workspace.length + 1);
		return rel || "."; // trailing-slash edge: never emit an empty summary
	}
	return tildifyHome(value);
}

function tildifyHome(value: string): string {
	if (!HOME) return value;
	if (value === HOME) return "~";
	if (value.startsWith(HOME + "/")) return "~/" + value.slice(HOME.length + 1);
	return value;
}

/**
 * Literal command compaction: `workspace/` prefixes vanish, bare workspace
 * mentions (followed by end/whitespace/quote/paren/separator) become `.`;
 * the same for home (`~/`, `~`) — home AFTER workspace so workspace wins.
 * A redundant leading `cd . && ` idiom is dropped; the result is re-flattened
 * because substitutions can leave double spaces behind.
 */
function compactCommand(cmd: string, workspace: string): string {
	let out = cmd.replaceAll(workspace + "/", "");
	out = replaceBare(out, workspace, ".");
	if (HOME) {
		out = out.replaceAll(HOME + "/", "~/");
		out = replaceBare(out, HOME, "~");
	}
	out = stripRedundantLeadingCd(out);
	return flattenOneLine(out);
}

/** Replace literal occurrences not followed by path-continuation characters. */
function replaceBare(text: string, literal: string, replacement: string): string {
	if (!literal) return text;
	const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`${escaped}(?=$|[\\s'\"\`(),;&|<>])`, "g"), replacement);
}

/** Leading `cd . && ` idioms (incl. simple-quoted dots) carry no information. */
const REDUNDANT_CD_PREFIXES = [
	"cd . && ", "cd ./ && ", "cd ~ && ",
	'cd "." && ', "cd '.' && ",
	'cd "./" && ', "cd './' && ",
	'cd "~" && ', "cd '~' && ",
];

function stripRedundantLeadingCd(cmd: string): string {
	for (const prefix of REDUNDANT_CD_PREFIXES) {
		if (!cmd.startsWith(prefix)) continue;
		const rest = cmd.slice(prefix.length);
		return rest || cmd; // stripping must never empty the summary
	}
	return cmd;
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
	/** The owning subagent id — the single run identifier. */
	agentId: string;
	workspace: string;
	/** Workspace run state: running | waiting_input | settling | terminating. */
	state: string;
	/** Report recovery ladder position, shown only when step > 0. */
	ladder?: { step: number; max: number };
	elapsedMs: number;
	deadlineMsLeft?: number;
	/** Known to the runtime; NOT rendered by the compact card (visible via op=status). */
	pid?: number;
	model?: string;
	thinking?: string;
	/** Latest live child stats (cost, context fill); omitted until the first report. */
	stats?: SessionStats;
	/** Known to the runtime; NOT rendered by the compact card (visible via op=status). */
	sessionId?: string;
	sessionFile?: string;
	activeTool?: ToolActivity;
	recentActivity?: ToolActivity[];
	progress?: Progress;
	/** Clock used for all live durations (injected for deterministic tests). */
	now: number;
}

/**
 * Compact operator view of a running RepoOwner, rendered into the tool call
 * via onUpdate. Plain text, no ANSI, no JSON. Optional segments are omitted —
 * the view only ever states what the runtime actually knows.
 *
 * Layout, hard-capped at 1 + 1 + 1 + 3 lines by construction:
 *   RepoOwner <id> · <state> · <elapsed> · deadline <d>[ · report recovery n/m]
 *   [<workspace basename> · <model> · <thinking> · <stats>]   — when known
 *   [▸ <tool>[ · <summary>][ · <age>]]                        — active tool
 *   [  <tool>[ · <summary>] · <age>]× ≤3                      — finished tools, newest first
 *
 * The duplicated agent id, pid/session rows, full workspace path, blank
 * separators and "current"/"recent" headers of the old card are gone: the
 * tool call header already shows the workspace, `subagent op=status` carries
 * the full details, and the renderer owns any trailing hints.
 */
export function formatRunStatus(v: RunStatusView): string {
	const lines: string[] = [];

	const head = [`RepoOwner ${v.agentId}`, v.state, formatDuration(v.elapsedMs)];
	if (v.deadlineMsLeft !== undefined) head.push(`deadline ${formatDuration(v.deadlineMsLeft)}`);
	if (v.ladder && v.ladder.step > 0) head.push(`report recovery ${v.ladder.step}/${v.ladder.max}`);
	lines.push(head.join(" · "));

	const meta = [
		v.workspace ? basename(v.workspace) : "",
		v.model,
		v.thinking,
		v.stats ? formatStatsBrief(v.stats) : "",
	].filter(Boolean);
	if (meta.length > 0) lines.push(meta.join(" · "));

	if (v.activeTool) {
		const parts = [v.activeTool.name];
		if (v.activeTool.summary) parts.push(v.activeTool.summary);
		parts.push(formatDuration(Math.max(0, v.now - v.activeTool.startedAt)));
		lines.push(`▸ ${parts.join(" · ")}`);
	} else {
		lines.push("activity: unknown (no active tool observed)");
	}
	lines.push(...formatProgress(v.progress, v.progress ? Math.max(0, v.now - v.progress.updatedAt) : undefined));

	// Top-down timeline: the producer appends finishes chronologically and trims
	// from the front, so the tail holds the newest entries — take it, then read
	// newest-first, directly under the active tool. Age counts from the finish
	// (`endedAt`), falling back to `startedAt` when no end was recorded.
	for (const entry of (v.recentActivity ?? []).slice(-RECENT_MAX).reverse()) {
		const parts = [entry.name];
		if (entry.summary) parts.push(truncate(entry.summary, RECENT_SUMMARY_MAX));
		parts.push(formatDuration(Math.max(0, v.now - (entry.endedAt ?? entry.startedAt))));
		lines.push(`  ${parts.join(" · ")}`);
	}

	return lines.join("\n");
}

/** Last path segment: the worktree directory name shown in the meta row. */
function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path;
}
