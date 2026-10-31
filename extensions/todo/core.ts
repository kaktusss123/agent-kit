/**
 * Pure todo domain model, ported from oh-my-pi's `tools/todo.ts`.
 *
 * No imports from pi or pi-tui: this module is unit-testable with `node --test`
 * in isolation. Wiring lives in `index.ts`, rendering in `render.ts`.
 *
 * Core invariants (all preserved from the OMP original):
 * - Task identity is the verbatim content string; duplicates are rejected.
 * - At most one `in_progress` task; the earliest `pending` task auto-promotes
 *   after every state-changing op. `blocked` tasks never auto-promote.
 * - A batch with any error is discarded wholesale (no half-applied state).
 * - State lives in tool-result details, so branching/rewind restore it.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** Persisted in tool-result details; the only state store (rehydration, UI). */
export interface TodoToolDetails {
	op?: TodoOperation;
	phases: TodoPhase[];
}

/** Raw params as handed to execute() (schema only enforces field types; `op` may be absent). */
export interface TodoOpEntry {
	op?: TodoOperation;
	list?: Array<{ phase: string; items: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
}

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

export function cloneTask(task: TodoItem): TodoItem {
	return task.blocker !== undefined
		? { content: task.content, status: task.status, blocker: task.blocker }
		: { content: task.content, status: task.status };
}

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

/** Enforce the single-pointer invariant after every mutating op. */
export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** The active todo task: the in-progress item, else the first pending one. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

/** Settled = completed or abandoned. Single source of truth for "done" counts. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/**
 * Rehydrate todo phases from a session branch: the latest non-error `todo`
 * tool result wins. Branching/rewind therefore restore the list for free.
 */
export function latestPhasesFromEntries(entries: readonly unknown[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: Record<string, unknown> } | undefined;
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as
			| { role?: string; toolName?: string; details?: unknown; isError?: boolean }
			| undefined;
		if (!message || message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;
		return clonePhases(details.phases as TodoPhase[]);
	}
	return [];
}

// =============================================================================
// Collapsed "walking viewport"
// =============================================================================

/** Closed rows kept directly above the open window so finishing a task is visible as it happens. */
const COLLAPSED_CLOSED_CONTEXT = 1;

export interface CollapsedTodoSelection {
	items: TodoItem[];
	summary: string;
}

function selectWithinCap(base: TodoItem[], cap: number): CollapsedTodoSelection {
	if (base.length <= cap) return { items: base, summary: "" };

	const active = base.filter(task => task.status === "in_progress");
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${hiddenActive === 1 ? "todo" : "todos"}`,
		};
	}

	const firstActiveIdx = active.length > 0 ? base.indexOf(active[0]!) : 0;
	const fill: TodoItem[] = [];
	for (let i = firstActiveIdx; i < base.length && active.length + fill.length < cap; i++) {
		const task = base[i]!;
		if (task.status === "in_progress") continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? `… ${hidden} more tasks` : "" };
}

/**
 * Rows for a collapsed phase: the last closed task leads (additive, never
 * costs an open row), then open tasks led by the active one. A phase with no
 * open work falls back to its closed tasks. `summary` counts open tasks that
 * did not fit.
 */
export function selectCollapsedTodos(tasks: TodoItem[], cap: number): CollapsedTodoSelection {
	const open = tasks.filter(task => !isClosedTodo(task));
	if (open.length === 0) return selectWithinCap(tasks, cap);
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

// =============================================================================
// Op application
// =============================================================================

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// instead of the canonical `list: [{phase, items}]`. Accept that shape.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntry, errors: string[]): { phases: TodoPhase[]; moved: number } {
	let moved = 0;
	switch (entry.op) {
		case "init":
			return { phases: initPhases(entry, errors), moved };
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return { phases, moved };
			const task = hit.task;
			// Idempotent no-op: already the in-progress task.
			if (task.status === "in_progress") return { phases, moved };
			if (task.status === "blocked") {
				errors.push(`Cannot start "${task.content}": task is blocked. Bring blocked tasks back to work with unblock, not start.`);
				return { phases, moved };
			}
			if (task.status === "completed" || task.status === "abandoned") {
				errors.push(`Cannot start "${task.content}": task is ${task.status} (terminal). Settled tasks never re-enter work.`);
				return { phases, moved };
			}
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== task) {
						candidate.status = "pending";
					}
				}
			}
			task.status = "in_progress";
			return { phases, moved: 1 };
		}
		case "done":
		case "drop": {
			// Terminal states are protected: settled tasks are never flipped by a
			// stale call. Targeted repeats of the same settle are idempotent no-ops;
			// targeted attempts to flip one terminal state to another are errors.
			// Phase-wide sweeps skip settled tasks instead of erroring.
			const to = entry.op === "done" ? "completed" : "abandoned";
			const targeted = Boolean(entry.task);
			const targets = getTaskTargets(phases, entry, errors);
			for (const task of targets) {
				if (task.status === to) continue; // idempotent no-op
				if (task.status === "completed" || task.status === "abandoned") {
					if (targeted) {
						errors.push(`Cannot ${entry.op} "${task.content}": task is already ${task.status} (terminal). Settled tasks never change state.`);
					}
					continue; // phase-wide: skip settled tasks
				}
				task.status = to;
				moved++;
			}
			return { phases, moved };
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return { phases, moved };
			}
			// Blocker notes ride on one Markdown checklist line and one HUD line,
			// so collapse whitespace runs to keep every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked; an already-blocked task
				// stays eligible so a later block can refine its note.
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				if (task.status !== "blocked") moved++;
				task.status = "blocked";
				task.blocker = reason;
			}
			return { phases, moved };
		}
		case "unblock": {
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return { phases, moved };
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
					moved++;
				}
			}
			return { phases, moved };
		}
		case "rm":
			return { phases: removeTasks(phases, entry, errors), moved };
		case "append":
			return { phases: appendItems(phases, entry, errors), moved };
		case "view":
			return { phases, moved };
		default:
			errors.push(`Unknown op "${entry.op}"`);
			return { phases, moved };
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred: `list` → `init`; `items` + `phase` → `append`; bare `items`
 * with no existing todos → `init`. Targeting args alone stay an error.
 */
export function inferTodoOp(args: TodoOpEntry, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. Anything else
 * that fails validation returns the error text for a normal model retry.
 */
export function resolveTodoParams(raw: TodoOpEntry, hasExistingPhases: boolean): TodoOpEntry | string {
	if (raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) return { ...raw, op: inferred };
		return `Invalid todo arguments: missing "op" and the payload shape does not identify an operation (use init/start/done/rm/drop/block/unblock/append/view)`;
	}
	return raw;
}

export function applyParams(phases: TodoPhase[], params: TodoOpEntry): { phases: TodoPhase[]; errors: string[]; moved: number } {
	const errors: string[] = [];
	const { phases: next, moved } = applyEntry(phases, params, errors);
	normalizeInProgressTask(next);
	return { phases: next, errors, moved };
}

/**
 * Apply one op to the canonical state with the tool's discard policy: a batch
 * with any error leaves the state untouched (persisting a half-applied batch
 * would make the natural retry hit "already exists" for the ops that landed).
 */
export function applyTodoOp(
	previous: TodoPhase[],
	entry: TodoOpEntry,
): { phases: TodoPhase[]; errors: string[]; moved: number } {
	const { phases: next, errors, moved } = applyParams(clonePhases(previous), entry);
	return errors.length > 0 ? { phases: previous, errors, moved } : { phases: next, errors, moved };
}

// =============================================================================
// Model-facing summary
// =============================================================================

export function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx]!;
	const done = current.tasks.filter(isClosedTodo).length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	const closedAll = tasks.filter(isClosedTodo).length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	// The active phase is the EARLIEST one still holding open work. Detect the
	// "worked ahead" case to explain an otherwise-surprising backward pointer.
	const workedAhead = phases.some((phase, idx) => idx > currentIdx && phase.tasks.some(isClosedTodo));
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

/**
 * Compact model-facing result of a successful mutating op: what changed,
 * overall progress, and the next actionable task. The full canonical state
 * lives in `details.phases`; `view` is the explicit way to see the whole list.
 */
export function formatMutationSummary(entry: TodoOpEntry, phases: TodoPhase[], moved: number): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	const closed = tasks.filter(isClosedTodo).length;
	const blocked = tasks.filter(task => task.status === "blocked").length;
	const progress = `${closed}/${tasks.length} done${blocked > 0 ? `, ${blocked} blocked` : ""}`;
	const next = nextActionableTask(phases);
	const nextPart =
		next === undefined
			? blocked > 0
				? " Nothing actionable — unblock or drop blocked tasks."
				: tasks.length > 0
					? " All done."
					: ""
			: ` Next: "${next.content}".`;

	switch (entry.op) {
		case "init":
			return `Todo list initialized: ${tasks.length} task(s) in ${phases.length} phase(s).${nextPart}`;
		case "start":
			// The started task is the next actionable one; naming it twice is noise.
			return `Started "${entry.task}". ${progress}.`;
		case "done":
			if (entry.phase) {
				const swept = moved > 0 ? ` (${moved} task(s))` : " (nothing left to settle)";
				return `Completed phase "${entry.phase}"${swept}. ${progress}.${nextPart}`;
			}
			return `Completed "${entry.task}". ${progress}.${nextPart}`;
		case "drop":
			if (entry.phase) {
				const swept = moved > 0 ? ` (${moved} task(s))` : " (nothing left to settle)";
				return `Dropped phase "${entry.phase}"${swept}. ${progress}.${nextPart}`;
			}
			return `Dropped "${entry.task}". ${progress}.${nextPart}`;
		case "block":
			if (entry.phase) {
				return `Blocked phase "${entry.phase}" (${moved} task(s)). ${progress}.`;
			}
			return `Blocked "${entry.task}"${entry.reason ? ` (${entry.reason})` : ""}. ${progress}.${nextPart}`;
		case "unblock":
			if (entry.phase) {
				return `Unblocked ${moved} task(s) in phase "${entry.phase}". ${progress}.${nextPart}`;
			}
			return `Unblocked "${entry.task}". ${progress}.${nextPart}`;
		case "rm":
			if (tasks.length === 0) return "Todo list cleared.";
			if (entry.task) return `Removed "${entry.task}". ${progress}.${nextPart}`;
			if (entry.phase) return `Removed phase "${entry.phase}". ${progress}.`;
			return `Removed tasks. ${progress}.`;
		case "append":
			return `Added ${entry.items?.length ?? 0} task(s) to "${entry.phase}". ${progress}.${nextPart}`;
		case "view":
			return formatSummary(phases, [], true);
	}
}

/** Model-facing text for a discarded (failed) batch. */
export function formatErrorResult(errors: string[]): string {
	return `Errors: ${errors.join("; ")}\nTodo state unchanged.`;
}

/** Open tasks grouped by phase, for stop-time reminders. */
export interface IncompletePhase {
	name: string;
	tasks: Array<{ content: string; status: "pending" | "in_progress" }>;
}

export function incompleteByPhase(phases: readonly TodoPhase[]): IncompletePhase[] {
	return phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.flatMap(task =>
				task.status === "pending" || task.status === "in_progress"
					? [{ content: task.content, status: task.status }]
					: [],
			),
		}))
		.filter(phase => phase.tasks.length > 0);
}

// =============================================================================
// Markdown rendering
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

/** Render todo phases as a Markdown checklist. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i]!.name}`);
		for (const task of phases[i]!.tasks) {
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
		}
	}
	return `${out.join("\n")}\n`;
}

// =============================================================================
// Display helpers
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}
