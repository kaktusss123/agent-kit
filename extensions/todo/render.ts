/**
 * Todo rendering, ported from oh-my-pi: the transient tool-result card and the
 * sticky HUD above the editor.
 *
 * Display text is sanitized at every render boundary (control sequences
 * stripped, tabs expanded); raw task content stays the identity key in state.
 * pi's default tool shell draws the card frame; we supply the content lines.
 */

import { Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type TodoItem,
	type TodoOpEntry,
	type TodoPhase,
	type TodoToolDetails,
	isClosedTodo,
	nextActionableTask,
	phaseRomanNumeral,
	selectCollapsedTodos,
} from "./core.ts";

/** Fixed budgets keep the HUD bounded regardless of plan size. */
const ACTIVE_TASK_CAP = 5;
const SUBSEQUENT_STAGE_CAP = 4;
const TAIL_LEN = 6;

/** HUD spine glyphs (pi's Theme has no tree symbols; OMP's were theme-owned). */
const TREE_BRANCH = "├─";
const TREE_VERTICAL = "│";

function forDisplay(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "  ");
}

function formatMeta(entry: TodoOpEntry): string {
	const parts: string[] = [entry.op ?? "update"];
	if (entry.task) parts.push(forDisplay(entry.task));
	if (entry.phase) parts.push(forDisplay(entry.phase));
	if (Array.isArray(entry.items) && entry.items.length > 0) {
		parts.push(`${entry.items.length} item${entry.items.length === 1 ? "" : "s"}`);
	}
	return parts.join(" ");
}

function formatTodoLine(item: TodoItem, theme: Theme): string {
	const label = forDisplay(item.content);
	switch (item.status) {
		case "completed":
			return theme.fg("success", `✓ ${theme.strikethrough(label)}`);
		case "in_progress":
			return theme.fg("accent", `◎ ${label}`);
		case "abandoned":
			return theme.fg("error", `✗ ${theme.strikethrough(label)}`);
		case "blocked": {
			const note = item.blocker ? ` (blocked: ${forDisplay(item.blocker)})` : " (blocked)";
			return theme.fg("warning", `○ ${label}${note}`);
		}
		default:
			return theme.fg("dim", `○ ${label}`);
	}
}

function phaseDisplayName(phase: TodoPhase, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(phase.name)}`;
}

function formatPhaseProgress(phase: TodoPhase, theme: Theme): string {
	const done = phase.tasks.filter(isClosedTodo).length;
	return theme.fg("dim", ` ${done}/${phase.tasks.length}`);
}

/** Tree connectors for a list of lines (`├─` between, `└─` last). */
function treeify(lines: string[], theme: Theme): string[] {
	return lines.map((line, i) => {
		const glyph = i === lines.length - 1 ? "└─ " : "├─ ";
		return theme.fg("borderMuted", glyph) + line;
	});
}

// =============================================================================
// Transient tool card
// =============================================================================

export function renderTodoCall(args: TodoOpEntry, theme: Theme): Component {
	const meta = theme.fg("muted", truncateToWidth(forDisplay(formatMeta(args)), 120));
	return new Text(`${theme.fg("toolTitle", theme.bold("todo"))} ${meta}`, 0, 0);
}

export interface TodoResultLike {
	content?: Array<{ type: string; text?: string }>;
	details?: TodoToolDetails;
	isError?: boolean;
}

export function renderTodoResult(
	result: TodoResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	if (result.isError) {
		const text = result.content?.find(c => c.type === "text")?.text ?? "Todo operation failed";
		return new Text(theme.fg("error", `✗ ${forDisplay(text)}`), 0, 0);
	}

	const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
	const allTasks = phases.flatMap(phase => phase.tasks);

	if (allTasks.length === 0) {
		const fallback = forDisplay(result.content?.find(c => c.type === "text")?.text ?? "No todos");
		return new Text(theme.fg("dim", fallback), 0, 0);
	}

	const lines: string[] = [`${theme.fg("toolTitle", theme.bold("Todo"))} ${theme.fg("dim", `${allTasks.length} tasks`)}`];
	for (let p = 0; p < phases.length; p++) {
		const phase = phases[p]!;
		const isActive = phase.tasks.some(task => task.status === "in_progress");
		const label = isActive
			? theme.fg("accent", theme.bold(phaseDisplayName(phase, p + 1)))
			: theme.fg("muted", phaseDisplayName(phase, p + 1));
		lines.push(`${label}${formatPhaseProgress(phase, theme)}`);

		const items = options.expanded
			? { items: phase.tasks, summary: "" }
			: selectCollapsedTodos(phase.tasks, ACTIVE_TASK_CAP);
		const taskLines = items.items.map(item => formatTodoLine(item, theme));
		for (const line of treeify(taskLines, theme)) {
			lines.push(line);
		}
		if (items.summary) lines.push(theme.fg("dim", `   ${items.summary}`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

// =============================================================================
// Sticky HUD (widget above the editor)
// =============================================================================

export function buildCompactTodoLine(phases: readonly TodoPhase[], theme: Theme): string {
	const all = phases.flatMap(phase => phase.tasks);
	const closed = all.filter(isClosedTodo).length;
	const active = nextActionableTask(phases);
	const header = `${theme.fg("accent", theme.bold("TODO"))} ${theme.fg("dim", `${closed}/${all.length}`)}`;
	const task = active
		? formatTodoLine(active, theme)
		: theme.fg("success", `✓ done`);
	return truncateToWidth(`${header} ${theme.fg("dim", "·")} ${task}`, 400);
}

export function buildHudLines(
	phases: readonly TodoPhase[],
	expanded: boolean,
	compact: boolean,
	width: number,
	theme: Theme,
): string[] {
	const visible = phases.filter(phase => phase.tasks.length > 0);
	if (visible.length === 0) return [];
	if (compact) return [buildCompactTodoLine(visible, theme)];

	const activeIdx = Math.max(
		0,
		visible.findIndex(phase => phase.tasks.some(task => task.status === "in_progress")),
	);

	const renderTasks = (phase: TodoPhase): string[] => {
		const selection = expanded
			? { items: phase.tasks, summary: "" }
			: selectCollapsedTodos(phase.tasks, ACTIVE_TASK_CAP);
		const taskLines = selection.items.map(item => formatTodoLine(item, theme));
		const tree = treeify(taskLines, theme).map(line => line);
		return selection.summary ? [...tree, theme.fg("dim", `… ${selection.summary}`)] : tree;
	};

	const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string[] => {
		const label = visible.length > 1 ? phaseDisplayName(phase, oneBased) : forDisplay(phase.name);
		const header = isActive
			? theme.fg("accent", theme.bold(label)) + formatPhaseProgress(phase, theme)
			: theme.fg("muted", label) + formatPhaseProgress(phase, theme);
		if (!isActive && !expanded) return [header];
		return [header, ...renderTasks(phase)];
	};

	// Collapsed: active stage + a bounded number of following stages.
	const baseIdx = expanded ? 0 : activeIdx;
	const slice = expanded ? visible.slice(baseIdx) : visible.slice(baseIdx, baseIdx + 1 + SUBSEQUENT_STAGE_CAP);
	const hiddenStages = visible.length - baseIdx - slice.length;

	// Flatten stage blocks; per-row spine glyphs form one continuous progress path.
	const spineGlyphs: string[] = [];
	const contentLines: string[] = [];
	const pushBlock = (rows: string[]): void => {
		if (rows.length === 0) return;
		spineGlyphs.push(`${TREE_BRANCH} `);
		contentLines.push(rows[0]!);
		for (let i = 1; i < rows.length; i++) {
			spineGlyphs.push(`${TREE_VERTICAL} `);
			contentLines.push(rows[i]!);
		}
	};
	for (let i = 0; i < slice.length; i++) {
		pushBlock(renderPhase(slice[i]!, baseIdx + i + 1, baseIdx + i === activeIdx));
	}
	if (hiddenStages > 0) {
		pushBlock([theme.fg("muted", `… ${hiddenStages} more stages`)]);
	}

	// Closing tail: `└` + horizontals, filled proportionally to overall progress.
	const hook = "└";
	const tail = hook + "─".repeat(Math.max(0, TAIL_LEN - visibleWidth(hook)));

	const totalTasks = visible.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closedTasks = visible.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
	const pathLen = contentLines.length + TAIL_LEN;
	let filled = Math.round((closedTasks / totalTasks) * pathLen);
	if (closedTasks > 0) filled = Math.max(filled, 1);
	if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

	const lines = [theme.fg("accent", theme.bold("TODO"))];
	for (let i = 0; i < contentLines.length; i++) {
		const glyph = spineGlyphs[i] ?? "";
		lines.push(`${theme.fg(i < filled ? "accent" : "dim", glyph)}${contentLines[i]}`);
	}
	const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
	lines.push(
		`${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`,
	);
	return lines.map(line => truncateToWidth(replaceTabs(line), width));
}

function replaceTabs(line: string): string {
	return line.includes("\t") ? line.replace(/\t/g, "  ") : line;
}
