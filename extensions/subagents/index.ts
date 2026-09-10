/**
 * subagents — native pi subagent runtime built around independent pi sessions.
 *
 * Each subagent is a separate `pi --mode rpc` process with its own session,
 * cwd, and lifecycle, owned by this extension in the main process (no daemon).
 *
 * Surfaces:
 * - `subagent` tool (LLM): one compact tool — spawn / status / steer /
 *   follow_up / wait / result / respond / cancel. `spawn` is async by
 *   default; blocking is modeled as spawn + wait.
 * - Background delivery: completed / failed / needs_input events reach the
 *   main model through pi.sendMessage with deliverAs:"steer" + triggerTurn,
 *   which pi 0.85.1 delivers at the next safe turn boundary when busy and as
 *   a fresh run when idle. The child transcript never enters main context.
 * - `/subagents` command: compact live status table.
 *
 * Escalation uses the standard RPC extension UI protocol: the child bridge's
 * `ask_parent` tool blocks on ctx.ui.input; the controller answers with
 * extension_ui_response, resuming the same child tool call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { LocalSubagentRuntime } from "./controller";
import { formatResult, formatStatusList } from "./delivery";
import type { SubagentRuntime } from "./types";
import { attachDelivery } from "./wiring";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
	/** Default blocking cap for subagent wait. */
	waitTimeoutSec: 600,
	/** Cap for spawn text in tool results. */
	spawnAckMaxChars: 400,
};

// =============================================================================
// Tool schema
// =============================================================================

const SubagentParams = Type.Object({
	op: StringEnum(["spawn", "status", "steer", "follow_up", "wait", "result", "respond", "cancel"] as const, {
		description: "Operation to perform on subagents",
	}),
	task: Type.Optional(Type.String({ description: "spawn: initial task prompt for the child agent" })),
	id: Type.Optional(Type.String({ description: "target agent id (omit for status to list all)" })),
	label: Type.Optional(Type.String({ description: "spawn: short name for the agent" })),
	cwd: Type.Optional(Type.String({ description: "spawn: working directory for the child (default: main cwd)" })),
	model: Type.Optional(Type.String({ description: "spawn: model pattern like provider/model (default: pi default)" })),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
			description: "spawn: thinking level for the child",
		}),
	),
	message: Type.Optional(Type.String({ description: "steer/follow_up: message for the child agent" })),
	answer: Type.Optional(Type.String({ description: "respond: answer to the child's pending question" })),
	timeoutSec: Type.Optional(
		Type.Integer({ description: "wait: max seconds to block (default 600)", minimum: 1, maximum: 3600 }),
	),
});

// =============================================================================
// Wiring
// =============================================================================

export default function (pi: ExtensionAPI) {
	let runtime: SubagentRuntime | null = null;

	function getRuntime(ctxCwd: string): SubagentRuntime {
		if (!runtime) {
			runtime = new LocalSubagentRuntime({ defaultCwd: ctxCwd });
			attachDelivery(pi, runtime);
		}
		return runtime;
	}

	pi.on("session_shutdown", async () => {
		// Main session is gone: owned children must not become orphans.
		if (runtime) {
			const r = runtime;
			runtime = null;
			await r.shutdown();
		}
	});

	// ------------------------------------------------------------------- tool

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Manage background subagents: independent pi agent processes with their own sessions.",
			"Ops: spawn (async, returns an id immediately; the child works in parallel), status,",
			"steer (redirect a running child), follow_up (queue work for after the current run,",
			"or resume an idle child), wait (block until completed/failed/needs_input), result",
			"(fetch the full persisted result), respond (answer a child's ask_parent question),",
			"cancel (abort and terminate a child).",
			"When a background child settles, you receive a short [subagent ...] event message;",
			"the child transcript is never added to your context — fetch details with op=result.",
		].join(" "),
		promptGuidelines: [
			"Use subagent op=spawn to delegate self-contained work that does not need your direct involvement, especially parallelizable or exploratory tasks.",
			"spawn returns immediately; keep working or spawn more agents, then use subagent op=wait to block for a specific child when you need its outcome.",
			"When a child reports needs_input, answer via subagent op=respond, or ask the user first and then respond.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rt = getRuntime(ctx.cwd);
			const op = params.op;
			try {
				switch (op) {
					case "spawn": {
						if (!params.task) return err("spawn requires `task`");
						const snap = await rt.spawn({
							task: params.task,
							label: params.label,
							cwd: params.cwd,
							model: params.model,
							thinking: params.thinking,
						});
						return ok(
							[
								`Spawned subagent ${snap.id} (“${snap.label}”) in ${snap.cwd}.`,
								`It is running in the background; continue your own work.`,
								`status/wait/result/steer/follow_up/cancel via op=... id=${snap.id}`,
							].join("\n"),
							{ snapshot: clipSnapshot(snap) },
						);
					}
					case "status": {
						const snaps = rt.inspect(params.id);
						if (params.id && snaps.length === 0) return err(`unknown agent id: ${params.id}`);
						return ok(formatStatusList(snaps), { agents: snaps.map(clipSnapshot) });
					}
					case "steer": {
						requireId(params);
						if (!params.message) return err("steer requires `message`");
						await rt.steer(params.id!, params.message);
						return ok(`Steering delivered to ${params.id}.`);
					}
					case "follow_up": {
						requireId(params);
						if (!params.message) return err("follow_up requires `message`");
						await rt.followUp(params.id!, params.message);
						return ok(
							`Follow-up queued for ${params.id}; it runs after the current work (or resumes the idle agent).`,
						);
					}
					case "wait": {
						requireId(params);
						const outcome = await rt.wait(params.id!, {
							timeoutMs: (params.timeoutSec ?? CONFIG.waitTimeoutSec) * 1000,
							signal,
						});
						switch (outcome.status) {
							case "completed":
								return ok(
									`Subagent ${params.id} completed. summary: ${outcome.summary}\nfull result via op=result id=${params.id}`,
									{ wait: outcome },
								);
							case "failed":
								return err(`Subagent ${params.id} failed: ${outcome.reason}`);
							case "needs_input":
								return ok(
									`Subagent ${params.id} asks: ${outcome.question}\nAnswer via op=respond id=${params.id} answer=<...> (ask the user if you don't know).`,
									{ wait: outcome },
								);
							case "cancelled":
								return ok(`Subagent ${params.id} was cancelled.`, { wait: outcome });
							case "timeout":
								return ok(
									`wait timed out; subagent ${params.id} is still ${outcome.state}. It keeps running in the background.`,
									{ wait: outcome },
								);
						}
						break;
					}
					case "result": {
						requireId(params);
						const result = await rt.result(params.id!);
						if (!result) {
							const snaps = rt.inspect(params.id!);
							if (snaps.length > 0) {
								return ok(
									`Subagent ${params.id} has no final result yet (state: ${snaps[0].state}). Use op=wait to block for completion.`,
								);
							}
							return err(`unknown agent id: ${params.id}`);
						}
						return ok(formatResult(result), { result });
					}
					case "respond": {
						requireId(params);
						if (!params.answer) return err("respond requires `answer`");
						await rt.respond(params.id!, params.answer);
						return ok(`Answer delivered to ${params.id}; the child resumes its work.`);
					}
					case "cancel": {
						requireId(params);
						await rt.cancel(params.id!);
						return ok(`Subagent ${params.id} cancelled and terminated.`);
					}
				}
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			return err(`unhandled op: ${op}`);
		},
	});

	// --------------------------------------------------------------- command

	pi.registerCommand("subagents", {
		description: "Show live subagent status",
		getArgumentCompletions: (prefix) => {
			const values = ["kill-all"];
			const items = values.map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("No subagents: runtime not started yet.", "info");
				return;
			}
			if (args.trim() === "kill-all") {
				await runtime.shutdown();
				ctx.ui.notify("All subagents cancelled and terminated.", "warning");
				return;
			}
			ctx.ui.notify(formatStatusList(runtime.inspect()), "info");
		},
	});
}

// -------------------------------------------------------------------- helpers

function requireId(params: { id?: string }): void {
	if (!params.id) throw new Error("this op requires `id` (see op=status for ids)");
}

function ok(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${text}` }],
		details: { error: text },
		isError: true,
	};
}

function clipSnapshot(s: ReturnType<SubagentRuntime["inspect"]>[number]) {
	return { ...s, task: s.task.length > 200 ? `${s.task.slice(0, 200)}…` : s.task };
}
