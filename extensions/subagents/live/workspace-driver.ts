/**
 * Live verification driver for the workspace_agent layer: runs the REAL
 * LocalSubagentRuntime + createWorkspaceLayer inside a real main pi process
 * and drives scenarios through the registered workspace_agent tool's
 * execute() — the same path the main LLM would take, including pre-dispatch
 * gates and model pinning (ctx.model comes from the dispatch request file,
 * filled by the verify script from the main session's actual get_state).
 *
 * Not part of the shipped extension wiring. State flows through
 * /tmp/pi-workspace-live/driver-log.json so the verify script can assert.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalSubagentRuntime } from "../controller";
import { createWorkspaceLayer, defaultProfileEntries } from "../workspace-agent";

const LIVE_DIR = process.env.PI_WDRV_LIVE_DIR ?? "/tmp/pi-workspace-live";
const LOG = path.join(LIVE_DIR, "driver-log.json");
/** Directory of the subagents extension (parent of live/). */
const SUBAGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface LogShape {
	events: Array<{ at: number; kind: string; [k: string]: unknown }>;
	messages: Array<{ at: number; customType?: string; content?: unknown; details?: unknown }>;
	results: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
	const log: LogShape = { events: [], messages: [], results: {} };
	// Atomic flush: the verify script polls this file concurrently, and a
	// torn read of a half-written JSON would crash its parser.
	const flush = () => {
		const tmp = LOG + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
		fs.renameSync(tmp, LOG);
	};
	const entry = (kind: string, data?: Record<string, unknown>) => {
		log.events.push({ at: Date.now(), kind, ...data });
		flush();
	};

	// Capture the workspace_agent tool and completion notifications.
	let workspaceTool: { execute: Function } | null = null;
	const realRegister = (pi as { registerTool: unknown }).registerTool;
	(pi as { registerTool: unknown }).registerTool = (def: { name: string; execute: Function }) => {
		if (def.name === "workspace_agent") workspaceTool = def;
		(realRegister as Function).call(pi, def);
	};
	const realSend = (pi as { sendMessage: unknown }).sendMessage;
	(pi as { sendMessage: unknown }).sendMessage = (message: { customType?: string; content?: unknown; details?: unknown }, options?: unknown) => {
		log.messages.push({ at: Date.now(), customType: message.customType, content: message.content, details: message.details });
		flush();
		return (realSend as Function).call(pi, message, options);
	};

	const runtime = new LocalSubagentRuntime({ defaultCwd: LIVE_DIR });
	runtime.onEvent((ev) => entry("generic-event", { event: { ...ev } }));
	// Profile override seam (live fail-closed proof): wdrv-profile replaces the
	// RepoOwner profile for subsequent dispatches — pointing it at a missing or
	// broken entry must fail closed before the task reaches a model.
	let profileOverride: string[] | null = null;
	const layer = createWorkspaceLayer(pi, () => runtime, {
		profileEntries: () => profileOverride ?? defaultProfileEntries(SUBAGENTS_DIR),
	});

	pi.registerCommand("wdrv-log", {
		description: "flush driver log marker",
		handler: async () => {
			entry("marker", {});
		},
	});

	// wdrv-dispatch <requestFile> <resultKey> — run a dispatch through the
	// real tool execute. Fire-and-forget: the command returns immediately and
	// the result lands in the log when the dispatch settles. Request file:
	// {workspace, task, timeout_ms, model, thinkingLevel}.
	pi.registerCommand("wdrv-dispatch", {
		description: "dispatch <requestFile> <resultKey>",
		handler: async (args) => {
			const [requestFile, resultKey] = args.trim().split(/\s+/);
			const req = JSON.parse(fs.readFileSync(requestFile, "utf8")) as {
				workspace: string;
				task: string;
				timeout_ms?: number;
				model: string;
				thinkingLevel?: string;
			};
			const [provider, ...rest] = req.model.split("/");
			const ctx = { model: { provider, id: rest.join("/") }, thinkingLevel: req.thinkingLevel ?? "low", cwd: LIVE_DIR };
			entry("dispatch-start", { resultKey, workspace: req.workspace });
			void (async () => {
				try {
					const pending = (workspaceTool as { execute: Function }).execute(
						`drv-${resultKey}`,
						{ workspace: req.workspace, task: req.task, timeout_ms: req.timeout_ms },
						undefined,
						undefined,
						ctx,
					);
					// Log the spawned child pid as soon as it exists: the newest
					// ALIVE owner child started after this dispatch began (earlier
					// scenarios' children are retired and must not match).
					const dispatchStartedAt = Date.now();
					const pidTimer = setInterval(() => {
						const owned = runtime.inspect()
							.filter((s) => s.label.startsWith("owner-") && s.alive && s.startedAt >= dispatchStartedAt - 2000)
							.sort((a, b) => b.startedAt - a.startedAt)[0];
						if (owned) {
							clearInterval(pidTimer);
							const already = log.events.some((e) => e.kind === "spawned" && e.resultKey === resultKey);
							if (!already) entry("spawned", { resultKey, agentId: owned.id, pid: owned.pid, model: owned.model });
						}
					}, 200);
					const res = (await pending) as { details: Record<string, unknown> };
					clearInterval(pidTimer);
					log.results[resultKey] = { details: res.details };
					flush();
					entry("dispatch-result", { resultKey, status: res.details.status });
				} catch (e) {
					log.results[resultKey] = { error: String(e) };
					flush();
					entry("dispatch-error", { resultKey, error: String(e) });
				}
			})();
		},
	});

	// wdrv-profile <comma-separated-paths|reset> — replace the RepoOwner
	// profile for subsequent dispatches (missing/broken-entry fail-closed proof).
	pi.registerCommand("wdrv-profile", {
		description: "profile <comma-separated-paths|reset>",
		handler: async (args) => {
			const arg = args.trim();
			profileOverride =
				arg === "" || arg === "reset"
					? null
					: arg.split(",").map((s) => s.trim()).filter(Boolean);
		},
	});

	// wdrv-respond <agentId> <answer...>
	pi.registerCommand("wdrv-respond", {
		description: "respond <agentId> <answer>",
		handler: async (args) => {
			const [agentId, ...rest] = args.trim().split(/\s+/);
			void runtime
				.respond(agentId, rest.join(" "))
				.then(() => entry("responded", { agentId }))
				.catch((e) => entry("respond-failed", { agentId, error: String(e) }));
		},
	});

	// wdrv-cancel <agentId> — the semantic cancel Main reaches via subagent op=cancel.
	pi.registerCommand("wdrv-cancel", {
		description: "cancel <agentId>",
		handler: async (args) => {
			const agentId = args.trim();
			void runtime
				.cancel(agentId)
				.then(() => entry("cancelled", { agentId }))
				.catch((e) => entry("cancel-failed", { agentId, error: String(e) }));
		},
	});

	// wdrv-query <runId> <resultKey> — durable query-mode lookup.
	pi.registerCommand("wdrv-query", {
		description: "query <runId> <resultKey>",
		handler: async (args) => {
			const [runId, resultKey] = args.trim().split(/\s+/);
			void (workspaceTool as { execute: Function })
				.execute(
					`drv-q-${resultKey}`,
					{ run_id: runId },
					undefined,
					undefined,
					{ model: undefined, cwd: LIVE_DIR },
				)
				.then((res: { details: unknown; isError?: boolean }) => {
					log.results[resultKey] = { details: res.details, isError: res.isError };
					flush();
				});
		},
	});

	// wdrv-spawn-generic <label> <task...> — A9 regression: plain subagent child.
	pi.registerCommand("wdrv-spawn-generic", {
		description: "spawn-generic <label> <task>",
		handler: async (args) => {
			const [label, ...rest] = args.trim().split(/\s+/);
			void runtime
				.spawn({ task: rest.join(" "), label })
				.then((snap) => entry("generic-spawned", { agentId: snap.id, label: snap.label }))
				.catch((e) => entry("generic-spawn-failed", { error: String(e) }));
		},
	});

	// wdrv-managed <agentId> — expose isManagedAgent for allow-list checks.
	pi.registerCommand("wdrv-managed", {
		description: "managed <agentId> <resultKey>",
		handler: async (args) => {
			const [agentId, resultKey] = args.trim().split(/\s+/);
			log.results[resultKey] = { managed: layer.isManagedAgent(agentId) };
			flush();
		},
	});
}
