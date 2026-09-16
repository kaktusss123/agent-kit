/**
 * subagents — native pi subagent runtime built around independent pi sessions.
 *
 * Each subagent is a separate `pi --mode rpc` process with its own session,
 * cwd, and lifecycle, owned by this extension in the main process (no daemon).
 *
 * There is ONE child-agent surface: the `subagent` tool. Workspace is a MODE
 * of a spawn, not a separate agent kind:
 *
 * - plain spawn (`cwd`) starts the child in a working directory without any
 *   repository-ownership semantics; the child picks its model by CLASS
 *   (modelClass: cheap | default | smart) resolved through the model-classes
 *   resolver before the process starts;
 * - workspace spawn (`workspace=<managed worktree>`) starts the child as the
 *   OWNER of that worktree (RepoOwner): the child inherits the main session's
 *   model (modelClass does not apply), strict validation and readiness happen
 *   before dispatch (fail closed), the spawn call blocks until a terminal
 *   outcome (done/partial/blocked) or needs_input with live progress rendered
 *   into the tool call, and the run gets the enforced deadline, the
 *   report_result envelope contract, and settled-state verification
 *   (ADR-0003) — see ./workspace-runs.
 *
 * Surfaces:
 * - `subagent` tool (LLM): spawn / status / steer / follow_up / wait / result /
 *   respond / cancel. Plain `spawn` is async by default; blocking is modeled
 *   as spawn + wait (workspace spawns block themselves). Spawn time management
 *   ops (status/result/respond/cancel) are identical for both modes; wait/
 *   steer/follow_up are rejected for workspace runs (the workspace spawn call
 *   owns the run outcome and its deadline).
 * - Background delivery: completed / failed / needs_input events reach the
 *   main model through pi.sendMessage with deliverAs:"steer" + triggerTurn,
 *   which pi 0.85.1 delivers at the next safe turn boundary when busy and as
 *   a fresh run when idle. The child transcript never enters main context.
 *   Detached workspace runs deliver their completion through the same channel.
 * - `/subagents` command: compact live status table.
 * - `agentkit-status` command: model-free, read-only structured status for an
 *   external RPC controller (areas subagents | task | all). The payload rides
 *   the standard extension UI input dialog under the wire title
 *   `agentkit:status`; see README ("External controller read").
 *
 * Escalation uses the standard RPC extension UI protocol: the child bridge's
 * `ask` tool (the canonical question contract, see ../ask/contract.ts) blocks
 * on ctx.ui.input carrying the structured request; the controller intercepts
 * it, surfaces it to Main, and answers with extension_ui_response, resuming
 * the same child tool call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { LocalSubagentRuntime } from "./controller";
import { resolveSpawnPair, type SpawnModelClass } from "./spawn-model";
import {
	formatAskRequestBlock,
	formatLiveSnapshot,
	formatResult,
	formatStatusList,
	RESOLVE_INSTRUCTION,
} from "./delivery";
import {
	createWorkspaceRuns,
	managedAgentOpPolicy,
	type WorkspaceRunView,
	type WorkspaceRuns,
} from "./workspace-runs";
import { renderSubagentCall, renderSubagentResult } from "./render";
import { attachDelivery } from "./wiring";
import { taskStatus } from "../task-workspace/flows";
import { resolveTaskRoot } from "../task-workspace/task-root";
import type { AgentSnapshot } from "./types";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
	/** Default blocking cap for subagent wait. */
	waitTimeoutSec: 600,
	/** Default deadline for workspace runs (whole run incl. the report ladder). */
	workspaceDeadlineSec: 600,
	/** Live progress refresh cadence for blocking waits. */
	liveStatusRefreshMs: 3000,
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
	cwd: Type.Optional(
		Type.String({
			description:
				"spawn: working directory for the child (default: main cwd). Plain working directory — no repository ownership; use `workspace` for that",
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description:
				"spawn: run this child as the OWNER of a managed task worktree (RepoOwner mode). The spawn call blocks until a terminal outcome (done/partial/blocked) or needs_input, with live progress in the tool call. The child inherits the main session model; modelClass does not apply",
		}),
	),
	deadlineSec: Type.Optional(
		Type.Integer({
			description:
				"spawn (workspace only): run deadline in seconds (default 600); covers the whole run including the report ladder",
			minimum: 1,
		}),
	),
	modelClass: Type.Optional(
		StringEnum(["cheap", "default", "smart"] as const, {
			description:
				'spawn (plain cwd only; ignored and rejected with workspace): model class for the child (default: "default" = current main model + thinking; "cheap"/"smart" = saved classes, configure via /model-class <class> set)',
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
	let runtime: LocalSubagentRuntime | null = null;
	let runs: WorkspaceRuns | null = null;

	function getRuntime(ctxCwd?: string): LocalSubagentRuntime {
		if (!runtime) {
			runtime = new LocalSubagentRuntime({ defaultCwd: ctxCwd ?? process.cwd() });
			attachDelivery(pi, runtime);
		}
		return runtime;
	}

	function getRuns(): WorkspaceRuns {
		if (!runs) {
			runs = createWorkspaceRuns(pi, (ctxCwd) => getRuntime(ctxCwd));
		}
		return runs;
	}

	// Proxy propagation: proxy-toggle emits "proxy-changed" after the user
	// flips the machine preference; every live child gets the bridge's `proxy`
	// command over the existing RPC link and reports the ack count back so
	// /proxy status can show it. Children spawned later pick the preference up
	// at their own session_start (bridge applies proxy-state.json).
	pi.events?.on?.("proxy-changed", (data) => {
		const enabled = (data as { enabled?: boolean } | null)?.enabled === true;
		const rt = runtime;
		if (!rt) {
			pi.events.emit("proxy-push-result", { enabled, acked: 0, total: 0 });
			return;
		}
		rt.pushProxyPreference(enabled)
			.then(({ acked, total }) => pi.events.emit("proxy-push-result", { enabled, acked, total }))
			.catch((err) =>
				pi.events.emit("proxy-push-result", {
					enabled,
					acked: 0,
					total: 0,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
	});

	pi.on("session_shutdown", async () => {
		// Main session is gone: owned children must not become orphans.
		if (runtime) {
			const r = runtime;
			runtime = null;
			runs = null;
			await r.shutdown();
		}
	});

	// ------------------------------------------------------------------- tool

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Manage background subagents: independent pi agent processes with their own sessions.",
			"One surface, two spawn modes. Plain spawn (cwd) starts a child in a working directory; it works in the",
			"background. Workspace spawn (workspace=<managed task worktree>) starts a child that OWNS that worktree:",
			"the call blocks until a terminal outcome (done/partial/blocked) or needs_input, with live progress in the",
			"tool call, an enforced deadline, and a structured report envelope (the child must finish by reporting).",
			"Ops: spawn, status, steer (redirect a running child), follow_up (queue work for after the current run),",
			"wait (block until completed/failed/needs_input; plain spawns only — a workspace spawn already blocks),",
			"result (fetch the full persisted result; workspace runs return the report envelope + Git facts), respond",
			"(answer a child's pending question), cancel (abort and terminate).",
			"When a background child settles, you receive a short [subagent ...] event message; the child transcript",
			"is never added to your context — fetch details with op=result.",
		].join(" "),
		promptGuidelines: [
			"Use subagent op=spawn to delegate self-contained work that does not need your direct involvement, especially parallelizable or exploratory tasks.",
			"spawn (plain cwd) returns immediately; keep working or spawn more agents, then use subagent op=wait to block for a specific child when you need its outcome.",
			"Workspace spawn: dispatch independent repo owners in parallel with multiple subagent calls with workspace=<worktree> in one block. The call blocks until a terminal outcome; its JSON carries the protocol outcome in `status`, and the owner's product outcome lives in `result.status` (present only when status is done).",
			"Workspace runs inherit the main session model — do not pass modelClass with workspace (it is rejected). Plain children pick a model class per spawn: omit modelClass or use \"default\" for ordinary delegated work; \"cheap\" for high-volume scouting, extraction, classification, and broad parallel research; \"smart\" for critical review, difficult reasoning, and explicit escalation. Configure cheap/smart via /model-class <class> set.",
			"Workspace terminal results include runtime-read `git_facts` (branch, HEAD SHA, dirty paths) — never ask the model for these; trust `git_facts` over any textual self-report about repository state.",
			"When a child reports needs_input, first try to resolve the request from your own conversation and task context — do not ask the user again for information that is already known.",
			"Only if the answer is unknown, use `ask` with the child's supplied request to get the missing decision, then answer via subagent op=respond id=<...> (a plain-text answer is enough; works for both modes).",
			"If a workspace run failed or settled blocked, do not re-dispatch blindly: inspect its worktree — after dispatch there is no fallback, the repair path is a new workspace spawn whose task begins with inspecting current state.",
		],
		parameters: SubagentParams,
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rt = getRuntime(ctx.cwd);
			const op = params.op;
			// Cross-tool allow-list for workspace-owned children: their lifecycle
			// events belong to the workspace run registry, so wait would steal
			// the one lifecycle event, and steer/follow_up would bypass the
			// run's deadline and task contract. status/result/respond/cancel
			// remain the Main-facing surface for both modes.
			if (params.id && runs?.isManaged(params.id)) {
				const policy = managedAgentOpPolicy(op);
				if (!policy.allowed) return err(policy.reason!);
			}
			try {
				switch (op) {
					case "spawn": {
						if (!params.task) return err("spawn requires `task`");
						// Ownership nesting is flat: workspace owners are created
						// exclusively by the main session. A child carrying
						// PI_SUBAGENT_ID (a workspace worker) may spawn plain
						// modelClass helpers but never another worktree owner —
						// rejected here, before any process can start.
						if (params.workspace && process.env.PI_SUBAGENT_ID) {
							return err(
								"workspace spawns can only be created by the main session: this worker cannot own another worktree — spawn plain `cwd` helpers instead",
							);
						}
						if (params.workspace) {
							// Workspace mode: the child owns a managed task worktree.
							// Validation, profile, readiness, deadline, report
							// envelope, and settled-state verification live in the
							// workspace run layer; the call blocks until terminal.
							if (params.modelClass) {
								return err(
									"modelClass does not apply to workspace spawns: the child inherits the main session model",
								);
							}
							if (params.cwd) {
								return err("workspace spawns root the child at the worktree; `cwd` does not apply");
							}
							const res = await getRuns().spawnRun({
								workspace: params.workspace,
								task: params.task,
								deadlineSec: params.deadlineSec,
								signal,
								onUpdate,
								model: ctx.model,
								thinkingLevel: ctx.thinkingLevel,
								cwd: ctx.cwd,
							});
							return res;
						}
						if (params.deadlineSec) {
							return err("deadlineSec applies to workspace spawns only (plain spawns are managed via wait)");
						}
						// Resolve the class BEFORE spawning: an unconfigured class or
						// a model that is gone fails the op without starting a child.
						const pair = resolveSpawnPair(params.modelClass ?? "default", ctx, pi.getThinkingLevel());
						const snap = await rt.spawn({
							task: params.task,
							label: params.label,
							cwd: params.cwd,
							model: pair.model,
							thinking: pair.thinking,
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
						const views = new Map<string, WorkspaceRunView>();
						for (const s of snaps) {
							const v = runs?.runView(s.id);
							if (v) views.set(s.id, v);
						}
						return ok(formatStatusList(snaps, views), {
							agents: snaps.map((s) => agentDetailView(s, views.get(s.id))),
						});
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
						const id = params.id!;
						// Live progress: while blocked, periodically render a
						// truthful snapshot of the child (state, current tool,
						// bounded recent activity) into the tool call. Display-only;
						// the child transcript stays isolated.
						let progressTimer: ReturnType<typeof setInterval> | undefined;
						try {
							if (onUpdate) {
								const emit = () => {
									try {
										const snap = rt.inspect(id)[0];
										if (snap) onUpdate({ content: [{ type: "text" as const, text: formatLiveSnapshot(snap) }] });
									} catch {
										// progress rendering must never break the wait
									}
								};
								emit();
								progressTimer = setInterval(emit, CONFIG.liveStatusRefreshMs);
								progressTimer.unref?.();
							}
							const outcome = await rt.wait(id, {
								timeoutMs: (params.timeoutSec ?? CONFIG.waitTimeoutSec) * 1000,
								signal,
							});
							switch (outcome.status) {
								case "completed":
									return ok(
										`Subagent ${id} completed. summary: ${outcome.summary}\nfull result via op=result id=${id}`,
										{ wait: outcome },
									);
								case "failed":
									return err(`Subagent ${id} failed: ${outcome.reason}`);
								case "needs_input":
									return ok(
										[
											`Subagent ${id} asks: ${outcome.question}`,
											...(outcome.request ? formatAskRequestBlock(outcome.request) : []),
											RESOLVE_INSTRUCTION,
											`Answer via op=respond id=${id} answer=<...>.`,
										].join("\n"),
										{ wait: outcome },
									);
								case "cancelled":
									return ok(`Subagent ${id} was cancelled.`, { wait: outcome });
								case "timeout":
									return ok(
										`wait timed out; subagent ${id} is still ${outcome.state}. It keeps running in the background.`,
										{ wait: outcome },
									);
							}
							break;
						} finally {
							// The progress loop dies on EVERY exit: outcome, timeout,
							// abort, and thrown errors. No leaked timers, no updates
							// after the tool call settled.
							if (progressTimer) clearInterval(progressTimer);
						}
					}
					case "result": {
						requireId(params);
						const view = runs?.runView(params.id!);
						if (view) {
							// Workspace-owned run: the protocol outcome (envelope +
							// Git facts) is the result surface.
							if (!view.terminal) {
								return ok(
									`Workspace run ${params.id} has no final result yet (state: ${view.state}). It settles under its deadline; completion arrives as an event.`,
									{ run: { workspace: view.workspace, state: view.state, deadlineMsLeft: view.deadlineMsLeft } },
								);
							}
							return ok(JSON.stringify(view.terminal), { result: view.terminal });
						}
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

	// ------------------------------------ external controller read (RPC)

	// Read-only structured status for an EXTERNAL RPC controller (A8 seam):
	// the payload rides the standard extension UI input dialog, keyed by wire
	// title exactly like the child `ask` dialog. The controller matches the
	// title, parses the JSON placeholder, and answers `cancelled` (there is
	// nothing to answer); the finite timeout makes the read fail closed when
	// no controller is listening. Model-free by construction: no LLM turn, no
	// session writes, and the runtime is never instantiated just to answer an
	// empty read.
	const STATUS_WIRE_TITLE = "agentkit:status";
	const STATUS_TIMEOUT_MS = 15000;

	pi.registerCommand("agentkit-status", {
		description:
			"Structured live status for an external RPC controller (model-free read; args: subagents | task | all, default all)",
		getArgumentCompletions: (prefix) => {
			const items = ["subagents", "task", "all"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const area = args.trim() || "all";
			const payload: Record<string, unknown> = { v: 1, area };
			if (area === "subagents" || area === "task" || area === "all") {
				const data: Record<string, unknown> = {};
				if (area === "subagents" || area === "all") {
					// `runtime ? inspect : []`: the read must not start the runtime.
					data.agents = (runtime ? runtime.inspect() : []).map((s) => agentDetailView(s, runs?.runView(s.id)));
				}
				if (area === "task" || area === "all") {
					data.task = await taskStatus({}, ctx.cwd, { taskRoot: resolveTaskRoot() });
				}
				payload.data = data;
			} else {
				payload.error = `unknown area: ${area} (subagents | task | all)`;
			}
			if (ctx.mode === "rpc") {
				// Wire transport: the payload is the dialog placeholder; the
				// controller answers cancelled. Timeout keeps the read finite.
				await ctx.ui.input(STATUS_WIRE_TITLE, JSON.stringify(payload), { timeout: STATUS_TIMEOUT_MS });
			} else if (typeof payload.error === "string") {
				ctx.ui.notify(`agentkit-status: ${payload.error}`, "error");
			} else {
				ctx.ui.notify(
					"agentkit-status serves external RPC controllers; use /subagents for a human-readable view.",
					"info",
				);
			}
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
				// cancelAll does not latch the runtime: new spawns keep working.
				await runtime.cancelAll();
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

function clipSnapshot(s: ReturnType<LocalSubagentRuntime["inspect"]>[number]) {
	return { ...s, task: s.task.length > 200 ? `${s.task.slice(0, 200)}…` : s.task };
}

/**
 * One agent's structured status detail: the clipped snapshot plus, for a
 * run-owned (workspace) agent, a compact view of its run. The single mapping
 * behind `subagent op=status` and the `agentkit-status` command, so the two
 * surfaces cannot drift; exposes only fields the existing status builders
 * already expose (full terminal outcomes stay on `subagent op=result`).
 */
export function agentDetailView(s: AgentSnapshot, view?: WorkspaceRunView) {
	return view
		? {
				...clipSnapshot(s),
				run: {
					workspace: view.workspace,
					state: view.state,
					...(view.terminal ? { status: view.terminal.status } : {}),
					deadlineMsLeft: view.deadlineMsLeft,
					...(view.ladder ? { ladder: view.ladder } : {}),
				},
			}
		: clipSnapshot(s);
}
