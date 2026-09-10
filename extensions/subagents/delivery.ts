/**
 * Formatting of model-visible subagent events and status views.
 *
 * The invariant: a background agent must never dump its transcript into the
 * main context. Deliveries are a few compact lines; the full result lives in
 * the persisted result file, reachable via `subagent result`.
 */
import type { AgentResult, AgentSnapshot, SubagentModelEvent } from "./types";

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
		case "cancelled":
			return `[subagent cancelled] ${ev.label} (id: ${ev.agentId})`;
		case "needs_input":
			return [
				`[subagent needs input] ${ev.label} (id: ${ev.agentId})`,
				`question: ${ev.question}`,
				`answer with subagent op=respond id=${ev.agentId} answer=<...>; the agent is suspended until then`,
			].join("\n");
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

export function formatSnapshot(s: AgentSnapshot): string {
	const elapsed = formatDuration(s.elapsedMs);
	const parts = [`${s.id}`, `“${s.label}”`, s.state];
	if (!s.alive) parts.push("(process exited)");
	if (s.model) parts.push(s.model);
	parts.push(elapsed);
	parts.push(s.cwd);
	const lines = [parts.join("  ")];
	if (s.pendingQuestion) lines.push(`  question: ${s.pendingQuestion}`);
	if (s.lastError) lines.push(`  error: ${s.lastError}`);
	return lines.join("\n");
}

export function formatStatusList(snapshots: AgentSnapshot[]): string {
	if (snapshots.length === 0) return "No subagents in this session.";
	const sorted = [...snapshots].sort(
		(a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.startedAt - a.startedAt,
	);
	return sorted.map(formatSnapshot).join("\n");
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

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}
