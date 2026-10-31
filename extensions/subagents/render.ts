/**
 * TUI rendering for the `subagent` tool: one-line call preview and result
 * cards. Display-only — execute() return values (content and details) are
 * never touched; these functions only shape what the transcript shows.
 *
 * Workspace terminal outcomes render as compact cards (status glyph, repo
 * identity from runtime-read Git facts, report envelope metrics); everything
 * else falls through as sanitized text. Sanitizing mirrors todo/render.ts:
 * control sequences stripped and tabs expanded at every render boundary.
 */

import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DirtyState } from "../task-workspace/types.ts";
import type { WorkspaceRunOutcome } from "./workspace-runs.ts";
import { validateProgress } from "./progress.ts";
import { formatProgress } from "./delivery.ts";

/** Collapsed summary cap (chars, like the model-visible blob budget). */
const SUMMARY_CAP = 280;
/** Expanded last_output cap (chars). */
const LAST_OUTPUT_CAP = 400;
/** Call-line task preview cap (chars). */
const TASK_PREVIEW_CAP = 80;
/** Scope segments shown collapsed before a "+N more" tail. */
const SCOPE_SHOWN = 2;

function forDisplay(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "  ");
}

function capChars(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** Local duration copy ("18s", "10m39s", "2h5m") — delivery.ts stays RPC-only. */
function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

// ============================================================ outcome shape

const OUTCOME_STATUSES: readonly string[] = ["done", "partial", "blocked", "needs_input", "running"];

/**
 * Structural detection of a WorkspaceRunOutcome: a known protocol status AND
 * a string `workspace`. AgentResult (plain runs) uses completed/failed/
 * cancelled and has no `workspace`, so it never matches and falls through
 * to the plain-text path.
 */
function asWorkspaceOutcome(value: unknown): WorkspaceRunOutcome | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (!OUTCOME_STATUSES.includes(v.status as string)) return undefined;
	if (typeof v.workspace !== "string") return undefined;
	return v as unknown as WorkspaceRunOutcome;
}

type OutcomeStyle = { glyph: string; color: Parameters<Theme["fg"]>[0] };

const OUTCOME_STYLES: Record<string, OutcomeStyle> = {
	done: { glyph: "✓", color: "success" },
	partial: { glyph: "◐", color: "warning" },
	blocked: { glyph: "✗", color: "error" },
	needs_input: { glyph: "?", color: "warning" },
	running: { glyph: "●", color: "accent" },
};

const CHECK_STYLES: Record<string, { glyph: string; color: Parameters<Theme["fg"]>[0] }> = {
	pass: { glyph: "✓", color: "success" },
	fail: { glyph: "✗", color: "error" },
	blocked: { glyph: "○", color: "warning" },
};

// ================================================================ call line

export interface SubagentCallArgs {
	op: string;
	task?: string;
	id?: string;
	label?: string;
	cwd?: string;
	workspace?: string;
	model?: string;
	role?: string;
}

export function renderSubagentCall(args: SubagentCallArgs, theme: Theme): Component {
	const parts: string[] = [args.op];
	if (args.op === "spawn") {
		if (args.workspace) parts.push(`workspace=${basename(forDisplay(args.workspace))}`);
		else if (args.cwd) parts.push(`cwd=${basename(forDisplay(args.cwd))}`);
		if (args.label) parts.push(`label=${forDisplay(args.label)}`);
		// Explicit model/role first, so an override is visible in the call
		// line before the task preview; omitted stays absent.
		if (args.model) parts.push(`model=${forDisplay(args.model)}`);
		if (args.role) parts.push(`role=${forDisplay(args.role)}`);
		if (args.task) parts.push(capChars(forDisplay(args.task.replace(/\s+/g, " ").trim()), TASK_PREVIEW_CAP));
	} else if (args.id) {
		parts.push(`id=${forDisplay(args.id)}`);
	}
	const meta = theme.fg("muted", truncateToWidth(parts.join(" "), 160));
	return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${meta}`, 0, 0);
}

// ============================================================== result card

export interface SubagentToolResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export function renderSubagentResult(
	result: SubagentToolResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const firstText = (): string | undefined =>
		result.content?.find((c) => c.type === "text")?.text;

	const details = result.details;
	const detailsError =
		typeof details === "object" && details !== null && "error" in details
			? (details as { error?: unknown }).error
			: undefined;

	if (result.isError || detailsError !== undefined) {
		const text = firstText() ?? "subagent op failed";
		return new Text(theme.fg("error", `✗ ${forDisplay(text)}`), 0, 0);
	}

	// Live progress (formatLiveSnapshot output streamed via onUpdate): show as-is.
	if (options.isPartial) {
		return new Text(theme.fg("dim", forDisplay(firstText() ?? "")), 0, 0);
	}

	const outcome = asWorkspaceOutcome(details) ?? asWorkspaceOutcome(
		typeof details === "object" && details !== null ? (details as { result?: unknown }).result : undefined,
	);
	if (outcome) {
		return renderOutcomeCard(outcome, options.expanded, theme);
	}

	// Plain management ops (snapshot/agents/wait/result details): verbatim text.
	return new Text(theme.fg("dim", forDisplay(firstText() ?? "")), 0, 0);
}

function dirtyText(dirty: DirtyState): string {
	const parts: string[] = [];
	if (dirty.staged.length > 0) parts.push(`${dirty.staged.length} staged`);
	if (dirty.unstaged.length > 0) parts.push(`${dirty.unstaged.length} unstaged`);
	return parts.length > 0 ? parts.join(", ") : "tree clean";
}

function renderOutcomeCard(outcome: WorkspaceRunOutcome, expanded: boolean, theme: Theme): Component {
	const lines: string[] = [];
	// Outer status is the DELIVERY outcome; envelope.status is the product
	// status. On divergence the header shows both and takes the reported
	// status's glyph/color, so a partial/blocked product never paints green.
	const reportedStyle =
		outcome.result && outcome.result.status !== outcome.status ? OUTCOME_STYLES[outcome.result.status] : undefined;
	const style = reportedStyle ?? OUTCOME_STYLES[outcome.status] ?? OUTCOME_STYLES.running!;
	const statusText = reportedStyle ? `${outcome.status} (report: ${outcome.result!.status})` : outcome.status;
	const dot = theme.fg("dim", " · ");

	const header = [
		theme.fg(style.color, `${style.glyph} ${statusText}`),
		theme.fg("muted", `owner-${basename(forDisplay(outcome.workspace))}`),
	];
	if (outcome.agentId) header.push(theme.fg("dim", `(${outcome.agentId})`));
	if (outcome.git_facts) {
		header.push(
			outcome.git_facts.branch
				? theme.fg("muted", `${outcome.git_facts.branch} @ ${outcome.git_facts.headSha.slice(0, 7)}`)
				: theme.fg("dim", "(detached)"),
		);
		const dirty = dirtyText(outcome.git_facts.dirty);
		header.push(dirty === "tree clean" ? theme.fg("dim", dirty) : theme.fg("warning", dirty));
	}
	lines.push(header.join(dot));

	if (outcome.status === "needs_input") {
		if (outcome.question) lines.push(theme.fg("warning", `question: ${forDisplay(outcome.question)}`));
		if (outcome.agentId) {
			lines.push(theme.fg("dim", `answer via subagent op=respond id=${outcome.agentId}`));
		}
	}
	if ((outcome.status === "running" || outcome.status === "needs_input") && outcome.deadlineMsLeft !== undefined) {
		lines.push(theme.fg("dim", `deadline ${formatDuration(outcome.deadlineMsLeft)}`));
	}
	if (outcome.dispatched !== false) {
		const progress = validateProgress(outcome.progress);
		for (const line of formatProgress(progress, outcome.progressAgeMs)) lines.push(theme.fg("dim", forDisplay(line)));
	}

	const envelope = outcome.result;
	if (envelope) {
		if (expanded) {
			lines.push(forDisplay(envelope.summary));
			for (const check of envelope.verification) {
				const cs = CHECK_STYLES[check.result] ?? CHECK_STYLES.blocked!;
				const cwd = check.cwd ? theme.fg("dim", ` · ${check.cwd}`) : "";
				lines.push(theme.fg(cs.color, `${cs.glyph} ${forDisplay(check.check)}`) + cwd);
			}
			if (envelope.changed_scope.length > 0) {
				lines.push(theme.fg("muted", `scope: ${envelope.changed_scope.map(forDisplay).join(", ")}`));
			}
			if (envelope.gaps.length > 0) lines.push(theme.fg("warning", `gaps: ${envelope.gaps.map(forDisplay).join("; ")}`));
			if (envelope.contract_conflicts && envelope.contract_conflicts.length > 0) {
				lines.push(theme.fg("error", `contract conflicts: ${envelope.contract_conflicts.map(forDisplay).join("; ")}`));
			}
			if (outcome.git_facts) {
				for (const p of outcome.git_facts.dirty.staged) lines.push(theme.fg("dim", `staged: ${forDisplay(p)}`));
				for (const p of outcome.git_facts.dirty.unstaged) lines.push(theme.fg("dim", `unstaged: ${forDisplay(p)}`));
			}
			if (outcome.last_output) lines.push(theme.fg("dim", capChars(forDisplay(outcome.last_output), LAST_OUTPUT_CAP)));
		} else {
			lines.push(capChars(forDisplay(envelope.summary), SUMMARY_CAP));
			const total = envelope.verification.length;
			const passed = envelope.verification.filter((c) => c.result === "pass").length;
			const allPassed = total > 0 && passed === total;
			const metrics = theme.fg(allPassed ? "success" : "error", `${allPassed ? "✓" : "✗"} ${passed}/${total} checks`);
			const scope = envelope.changed_scope.slice(0, SCOPE_SHOWN);
			let tail = "";
			if (scope.length > 0) tail += theme.fg("dim", ` · scope: ${scope.map(forDisplay).join(", ")}`);
			if (envelope.changed_scope.length > SCOPE_SHOWN) {
				tail += theme.fg("dim", ` +${envelope.changed_scope.length - SCOPE_SHOWN} more`);
			}
			lines.push(metrics + tail);
		}
	}

	if (outcome.reason) lines.push(theme.fg("error", `reason: ${forDisplay(outcome.reason)}`));
	if (outcome.child_may_have_mutated_repo) {
		lines.push(theme.fg("warning", "child may have mutated the repo after its last report"));
	}
	if (outcome.dispatched === false) lines.push(theme.fg("dim", "not dispatched"));
	if (!expanded) lines.push(keyHint("app.tools.expand", "to expand"));

	return new Text(lines.join("\n"), 0, 0);
}
