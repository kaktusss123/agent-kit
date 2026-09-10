/**
 * todo — phased todo-list extension for pi, ported from oh-my-pi.
 *
 * Surfaces:
 * - `todo` tool (LLM): phased list, transcript persistence via result details.
 * - Transcript card: phase tree with progress and a collapsed walking viewport.
 * - Sticky HUD widget above the editor with a progress spine and auto-clear.
 * - Stop-time reminders + hidden mid-run nudges (ported guards included).
 * - Eager prelude: a hidden "consider creating a list" reminder on the first
 *   user prompt (`eager: "preferred"`; off by default, matching OMP defaults).
 * - `/todo` command: markdown snapshot, `expand`/`collapse` for the HUD.
 *
 * State lives in tool-result details and is rehydrated from the session
 * branch, so branching, rewinding, and resuming restore the list for free.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	type TodoOpEntry,
	type TodoPhase,
	type TodoToolDetails,
	applyTodoOp,
	clonePhases,
	formatErrorResult,
	formatMutationSummary,
	formatSummary,
	latestPhasesFromEntries,
	phasesToMarkdown,
	resolveTodoParams,
} from "./core";
import { buildHudLines, renderTodoCall, renderTodoResult } from "./render";
import {
	type ReminderEngineConfig,
	TodoReminderEngine,
	allTodosClosed,
	buildStopReminderText,
} from "./reminders";

import toolDescription from "./prompts/tool-description.md" with { type: "text" };
import eagerPreludePrompt from "./prompts/eager-prelude.md" with { type: "text" };
import midRunNudgePrompt from "./prompts/mid-run-nudge.md" with { type: "text" };

// =============================================================================
// Configuration (OMP defaults; edit here — no settings registry by design)
// =============================================================================

const CONFIG = {
	/** "off" — model decides (OMP default); "preferred" — hidden reminder on the first prompt. */
	eager: "off" as "off" | "preferred",
	reminders: true,
	remindersMax: 3,
	midRunNudges: true,
	midRunMutationThreshold: 12,
	midRunMaxPerCycle: 2,
	/** Delay before a fully-settled list is removed from the HUD, in seconds. */
	hudClearDelaySec: 60,
	/** Below this terminal row count the HUD renders as a single line. */
	compactRowsThreshold: 24,
	/** Tools whose successful calls count toward the mid-run nudge threshold. */
	mutatingTools: ["bash", "edit", "write"],
};

const reminderConfig: ReminderEngineConfig = {
	reminders: CONFIG.reminders,
	remindersMax: CONFIG.remindersMax,
	midRunNudges: CONFIG.midRunNudges,
	midRunMutationThreshold: CONFIG.midRunMutationThreshold,
	midRunMaxPerCycle: CONFIG.midRunMaxPerCycle,
	mutatingTools: new Set(CONFIG.mutatingTools),
};

const WIDGET_NAME = "todo";
const TODO_EAGER_CUSTOM_TYPE = "todo:eager-prelude";
const TODO_REMINDER_CUSTOM_TYPE = "todo:stop-reminder";
const TODO_NUDGE_CUSTOM_TYPE = "todo:mid-run-nudge";

// =============================================================================
// Tool schema
// =============================================================================

const TodoParams = Type.Object({
	op: Type.Optional(
		StringEnum(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] as const),
	),
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String({ description: "phase name" }),
				items: Type.Array(Type.String({ description: "task content" }), {
					description: "tasks for this phase",
				}),
			}),
			{ description: "phased task list (init)" },
		),
	),
	task: Type.Optional(Type.String({ description: "task content (verbatim)" })),
	phase: Type.Optional(Type.String({ description: "phase name" })),
	items: Type.Optional(
		Type.Array(Type.String({ description: "task content" }), {
			description: "tasks for single-phase init or append",
		}),
	),
	reason: Type.Optional(Type.String({ description: "blocker note (block op)" })),
});

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Canonical in-memory state; rehydrated from the session branch on
	// session_start / session_tree, written on successful tool ops.
	let phases: TodoPhase[] = [];
	let hudExpanded = false;
	let eagerFiredThisSession = false;
	let hudClearTimer: ReturnType<typeof setTimeout> | undefined;

	const engine = new TodoReminderEngine(reminderConfig);

	const assistantTextFromMessages = (messages: readonly unknown[]): string => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown } | undefined;
			if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = (message.content as Array<{ type?: string; text?: string }>)
				.filter(block => block.type === "text" && typeof block.text === "string")
				.map(block => block.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
		return "";
	};

	// Count of user messages already in the branch. Depending on pi's commit
	// ordering the current prompt may or may not be appended before
	// before_agent_start fires, so the eager gate treats 0 and 1 alike.
	const branchUserCount = (ctx: ExtensionContext): number =>
		ctx.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user")
			.length;

	const rehydrate = (ctx: ExtensionContext): void => {
		phases = latestPhasesFromEntries(ctx.sessionManager.getBranch());
	};

	const isCompact = (): boolean => (process.stdout.rows ?? 24) < CONFIG.compactRowsThreshold;

	const clearHudTimer = (): void => {
		if (hudClearTimer) {
			clearTimeout(hudClearTimer);
			hudClearTimer = undefined;
		}
	};

	const refreshHud = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		clearHudTimer();
		const visible = phases.filter(phase => phase.tasks.length > 0);
		if (visible.length === 0) {
			ctx.ui.setWidget(WIDGET_NAME, undefined);
			return;
		}
		if (allTodosClosed(visible)) {
			// Let the finished list linger, then remove the widget (session state stays).
			hudClearTimer = setTimeout(() => {
				hudClearTimer = undefined;
				ctx.ui.setWidget(WIDGET_NAME, undefined);
			}, CONFIG.hudClearDelaySec * 1000);
			hudClearTimer.unref?.();
		}
		ctx.ui.setWidget(WIDGET_NAME, (_tui, theme) => ({
			render(width: number): string[] {
				return buildHudLines(phases, hudExpanded, isCompact(), width, theme);
			},
			invalidate(): void {},
		}));
	};

	// =========================================================================
	// Tool
	// =========================================================================

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: toolDescription,
		promptSnippet: "Write a structured phased todo list to track progress within a session",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const previousPhases = clonePhases(phases);
			const resolved = resolveTodoParams(params as TodoOpEntry, previousPhases.length > 0);
			if (typeof resolved === "string") {
				return {
					content: [{ type: "text", text: resolved }],
					details: { phases: previousPhases } satisfies TodoToolDetails,
					isError: true,
				};
			}
			// view is the model's explicit way to read the full list; mutations
			// answer with a compact delta — the canonical state travels in details.
			if (resolved.op === "view") {
				return {
					content: [{ type: "text", text: formatSummary(previousPhases, [], true) }],
					details: { op: "view", phases: previousPhases } satisfies TodoToolDetails,
				};
			}
			const { phases: updated, errors, moved } = applyTodoOp(previousPhases, resolved);
			const failed = errors.length > 0;
			if (!failed) phases = updated;
			refreshHud(ctx);

			return {
				content: [
					{
						type: "text",
						text: failed ? formatErrorResult(errors) : formatMutationSummary(resolved, updated, moved),
					},
				],
				details: { op: resolved.op, phases: updated } satisfies TodoToolDetails,
				isError: failed ? true : undefined,
			};
		},

		renderCall(args, theme) {
			return renderTodoCall(args as TodoOpEntry, theme);
		},

		renderResult(result, options, theme) {
			return renderTodoResult(result as { details?: TodoToolDetails; isError?: boolean }, options, theme);
		},
	});

	// =========================================================================
	// Session lifecycle: rehydration
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		eagerFiredThisSession = false;
		engine.resetCycle();
		rehydrate(ctx);
		refreshHud(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rehydrate(ctx);
		refreshHud(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearHudTimer();
	});

	// =========================================================================
	// Eager prelude (first user prompt)
	// =========================================================================

	pi.on("before_agent_start", async (event, ctx) => {
		engine.resetCycle();
		if (CONFIG.eager !== "preferred") return;
		if (eagerFiredThisSession) return;
		if (phases.length > 0) return;
		// Skip prompts that are themselves questions or exclamations — OMP parity.
		const trimmed = event.prompt.trimEnd();
		if (trimmed.endsWith("?") || trimmed.endsWith("!")) return;
		if (branchUserCount(ctx) > 1) return;
		eagerFiredThisSession = true;
		return {
			message: {
				customType: TODO_EAGER_CUSTOM_TYPE,
				content: eagerPreludePrompt,
				display: false,
			},
		};
	});

	// =========================================================================
	// Stop-time reminder
	// =========================================================================

	pi.on("agent_end", async (event) => {
		const assistantText = assistantTextFromMessages(event.messages);
		const decision = engine.consumeStopReminder(phases, assistantText);
		if (!decision) return;
		await pi.sendMessage(
			{
				customType: TODO_REMINDER_CUSTOM_TYPE,
				content: buildStopReminderText(decision.incomplete, decision.attempt, decision.max),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	// =========================================================================
	// Tool-result accounting + hidden mid-run nudges
	// =========================================================================

	pi.on("tool_execution_end", async (event, ctx) => {
		engine.recordToolResult(event.toolName, event.isError);
		if (event.toolName === "todo" && event.isError) {
			const text = (event.result?.content as Array<{ type?: string; text?: string }> | undefined)?.find(
				c => c.type === "text",
			)?.text;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Todo update failed${text ? `: ${text}` : ". Progress may be stale until todo succeeds."}`,
					"warning",
				);
			}
			return;
		}
		const openCount = engine.takeMidRunNudge(phases);
		if (openCount === null) return;
		await pi.sendMessage(
			{
				customType: TODO_NUDGE_CUSTOM_TYPE,
				content: midRunNudgePrompt.replace("{{count}}", String(openCount)),
				display: false,
			},
			{ deliverAs: "steer" },
		);
	});

	// =========================================================================
	// /todo command
	// =========================================================================

	pi.registerCommand("todo", {
		description: "Show the todo list; `/todo expand` and `/todo collapse` control the HUD",
		handler: async (args, ctx) => {
			const verb = args.trim().toLowerCase();
			if (verb === "expand" || verb === "collapse") {
				hudExpanded = verb === "expand";
				refreshHud(ctx);
				ctx.ui.notify(`Todo HUD ${hudExpanded ? "expanded" : "collapsed"}.`, "info");
				return;
			}
			if (verb && verb !== "show") {
				ctx.ui.notify(`Unknown /todo verb "${verb.trim()}". Supported: (show) | expand | collapse`, "error");
				return;
			}
			rehydrate(ctx);
			if (phases.length === 0) {
				ctx.ui.notify("No todos.", "info");
				return;
			}
			ctx.ui.notify(phasesToMarkdown(phases).trimEnd(), "info");
		},
	});
}
