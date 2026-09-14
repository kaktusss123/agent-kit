/**
 * Formatting of model-visible subagent events and status views.
 *
 * The invariant: a background agent must never dump its transcript into the
 * main context. Deliveries are a few compact lines; the full result lives in
 * the persisted result file, reachable via `subagent result`.
 */
import type { AgentResult, AgentSnapshot, SessionStats, SubagentModelEvent } from "./types";
import { formatAskRequestJson, type AskInput } from "../ask/contract";

/**
 * Structured workspace-run facts for the status view. Structural twin of the
 * workspace layer's run view (kept local so delivery stays import-light).
 */
export interface StatusRunView {
	state: string;
	workspace: string;
	deadlineMsLeft: number;
	ladder?: { step: number; max: number };
}

/**
 * The resolver instruction (SPEC §10): Main first tries to answer a child's
 * ask from context it already has; only an unknown decision is re-asked of
 * the user through Main's own `ask`.
 */
export const RESOLVE_INSTRUCTION =
	"This agent is waiting for input. " +
	"If the answer is already established by the current conversation, task context, accepted decisions, " +
	"or supplied evidence, resolve the request directly — do not ask the user again for information that is already known. " +
	"If the answer is not known, use `ask` with the supplied request to obtain the missing decision. " +
	"Then respond to the waiting agent.";

/**
 * Shared needs_input rendering for every Main-facing surface (background
 * delivery, subagent wait, and workspace-run needs_input surfaces): the flat summary,
 * the resolution instruction, and the lossless structured request.
 */
export function formatNeedsInputBody(question: string, request: AskInput | undefined): string[] {
	const lines = [`question: ${question}`];
	if (request && request.questions.length > 0) {
		lines.push(...formatAskRequestBlock(request));
	}
	lines.push(RESOLVE_INSTRUCTION);
	return lines;
}

/**
 * The structured request as a fenced json block. A payload containing ```
 * would close a ```-fence early, so a longer fence is used when needed
 * (CommonMark: the closing fence must be at least as long as the opening
 * one). Shared by the background delivery and the `subagent wait` result.
 */
export function formatAskRequestBlock(request: AskInput): string[] {
	const json = formatAskRequestJson(request);
	const ticks = json.includes("```") ? "````" : "```";
	return ["request:", `${ticks}json`, json, ticks];
}

export function formatModelEvent(ev: SubagentModelEvent): string {
	switch (ev.kind) {
		case "completed":
			return [
				`[subagent completed] ${ev.label} (id: ${ev.agentId})`,
				`summary: ${ev.summary}`,
				`full result available via subagent op=result id=${ev.agentId}`,
			].join("\n");
		case "failed":
			return [
				`[subagent failed] ${ev.label} (id: ${ev.agentId})`,
				`reason: ${ev.reason}`,
				`details available via subagent op=result id=${ev.agentId}`,
			].join("\n");
		case "needs_input":
			return [
				`[subagent needs input] ${ev.label} (id: ${ev.agentId})`,
				...formatNeedsInputBody(ev.question, ev.request),
				`answer with subagent op=respond id=${ev.agentId} answer=<...>; the agent is suspended until then`,
			].join("\n");
		case "cancelled":
		case "input_resolved":
			// cancelled: consumed by waiters only, never delivered in the
			// background (the cancelling side already knows the outcome).
			// input_resolved: workspace-routed only; never reaches generic delivery.
			return "";
	}
}

const STATE_ORDER: Record<AgentSnapshot["state"], number> = {
	running: 0,
	starting: 1,
	waiting_input: 2,
	completed: 3,
	failed: 3,
	cancelled: 3,
};

export function formatSnapshot(s: AgentSnapshot, run?: StatusRunView): string {
	const elapsed = formatDuration(s.elapsedMs);
	const parts = [`${s.id}`, `“${s.label}”`, s.state];
	if (!s.alive) parts.push("(process exited)");
	if (s.model) parts.push(s.model);
	parts.push(elapsed);
	parts.push(s.cwd);
	const lines = [parts.join("  ")];
	if (s.pendingQuestion) lines.push(`  question: ${s.pendingQuestion}`);
	if (s.lastError) lines.push(`  error: ${s.lastError}`);
	if (run) {
		const runParts = [run.workspace, `state ${run.state}`, `deadline ${formatDuration(run.deadlineMsLeft)}`];
		if (run.ladder && run.ladder.step > 0) runParts.push(`report recovery ${run.ladder.step}/${run.ladder.max}`);
		lines.push(`  run: ${runParts.join(" · ")}`);
	}
	return lines.join("\n");
}

export function formatStatusList(snapshots: AgentSnapshot[], runViews?: Map<string, StatusRunView>): string {
	if (snapshots.length === 0) return "No subagents in this session.";
	const sorted = [...snapshots].sort(
		(a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.startedAt - a.startedAt,
	);
	return sorted.map((s) => formatSnapshot(s, runViews?.get(s.id))).join("\n");
}

/** Compact human token count ("874", "87.5k", "1.2M") for status views. */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return dropTenthsZero(`${(n / 1_000_000).toFixed(1)}M`);
	if (n >= 1_000) return dropTenthsZero(`${(n / 1_000).toFixed(1)}k`);
	return `${n}`;
}

function dropTenthsZero(text: string): string {
	return text.includes(".0") ? text.replace(".0", "") : text;
}

/**
 * Compact cost + context usage ("$0.4231 · ctx 87.5k/200k (44%)"). Parts the
 * runtime does not know are omitted; an empty result means nothing is known
 * yet and callers skip the segment entirely.
 */
export function formatStatsBrief(stats: SessionStats): string {
	const parts: string[] = [];
	if (stats.cost !== undefined) parts.push(`$${stats.cost.toFixed(4)}`);
	const ctx = stats.contextUsage;
	if (ctx) {
		if (typeof ctx.tokens === "number") {
			let text = ctx.contextWindow
				? `${formatTokenCount(ctx.tokens)}/${formatTokenCount(ctx.contextWindow)}`
				: formatTokenCount(ctx.tokens);
			if (typeof ctx.percent === "number") text += ` (${ctx.percent}%)`;
			parts.push(`ctx ${text}`);
		} else if (typeof ctx.percent === "number") {
			parts.push(`ctx ${ctx.percent}%`);
		}
	}
	return parts.join(" · ");
}

export function formatResult(result: AgentResult): string {
	const lines = [
		`subagent ${result.id} “${result.label}” — ${result.status}`,
		`task: ${oneLine(result.task)}`,
	];
	if (result.sessionFile) lines.push(`session: ${result.sessionFile}`);
	if (result.model) lines.push(`model: ${result.model}`);
	lines.push(`started: ${new Date(result.startedAt).toISOString()}`);
	if (result.endedAt) lines.push(`ended: ${new Date(result.endedAt).toISOString()}`);
	if (result.tokens) {
		const t = result.tokens;
		lines.push(
			`tokens: in ${t.input}, out ${t.output}${t.cost !== undefined ? `, cost $${t.cost.toFixed(4)}` : ""}`,
		);
	}
	if (result.failureReason) lines.push(`failure: ${result.failureReason}`);
	lines.push("");
	lines.push(result.finalText?.trim() || "(no final assistant text)");
	return lines.join("\n");
}

function oneLine(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Live progress view for a blocking wait: truthful point-in-time snapshot of
 * the child (identity, state, elapsed, current tool, bounded recent activity).
 * Rendered into the tool call via Pi's transient onUpdate channel — display
 * only, never Main's LLM context.
 */
export function formatLiveSnapshot(s: AgentSnapshot): string {
	const head = [`subagent ${s.id} “${s.label}”`, s.state, formatDuration(s.elapsedMs)];
	const statsBrief = s.stats ? formatStatsBrief(s.stats) : "";
	if (statsBrief) head.push(statsBrief);
	if (s.model) head.push(s.model);
	if (!s.alive) head.push("(process exited)");
	const lines = [head.join(" · ")];
	if (s.pendingQuestion) lines.push(`question: ${s.pendingQuestion}`);
	if (s.lastError) lines.push(`error: ${s.lastError}`);
	if (s.activeTool) {
		const age = formatDuration(Math.max(0, Date.now() - s.activeTool.startedAt));
		const parts = [s.activeTool.name, s.activeTool.summary, age].filter(Boolean);
		lines.push(`current: ${parts.join(" · ")}`);
	}
	if (s.recentActivity && s.recentActivity.length > 0) {
		lines.push("recent:");
		for (const entry of s.recentActivity) {
			const parts = [entry.name, entry.summary].filter(Boolean);
			lines.push(`  ${parts.join(" · ")}`);
		}
	}
	return lines.join("\n");
}

/** Compact human duration ("18s", "10m39s", "2h5m") shared by status views. */
export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}
