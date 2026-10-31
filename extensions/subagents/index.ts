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
 *   repository-ownership semantics; the child's model is picked explicitly
 *   (`model`: `provider/id[:thinking]`) or by ROLE (`role`: explore / helper /
 *   review, bound per machine in subagent-roles.json; unbound = the session
 *   model) — resolved before the process starts;
 * - workspace spawn (`workspace=<managed worktree>`) starts the child as the
 *   OWNER of that worktree (RepoOwner): `model` applies identically and the
 *   role is always `owner` (its binding, else the session model); strict
 *   validation and readiness happen before dispatch (fail closed), the spawn
 *   call blocks until a terminal outcome (done/partial/blocked) or
 *   needs_input with live progress rendered into the tool call, and the run
 *   gets the enforced deadline, the report_result envelope contract, and
 *   settled-state verification (ADR-0003) — see ./workspace-runs.
 *
 * Surfaces:
 * - `subagent` tool (LLM): spawn / status / steer / follow_up / wait / result /
 *   respond / cancel. Plain `spawn` is async by default; blocking is modeled
 *   as spawn + wait (workspace spawns block themselves). Spawn time management
 *   ops (status/result/respond/cancel) work for both modes. Workspace wait
 *   continues a bounded wait through its registry; steer is queue-only and
 *   rejects settling/terminating owners. follow_up stays forbidden.
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
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { LocalSubagentRuntime } from "./controller";
import { resolveSpawnPair } from "./spawn-model";
import { loadRoleBindings, rolesPath } from "./roles";
import { roleCommandCompletions, runRoleCommand } from "./role-command";
import {
	requireProviderExtensions,
	type ConfiguredPackageRef,
	type ParentRuntimeFacts,
} from "./provider-extensions";
import { resolveAgentDir } from "../proxy/proxy-lib";
import { defaultResultsDir, sumSessionCost } from "./result-store";
import { ownDeliveryInFlight } from "./steering-wake";
import type { WaitOutcome } from "./types";
import {
	formatAskRequestBlock,
	formatLiveSnapshot,
	formatOrphanList,
	formatResult,
	formatStatusList,
	RESOLVE_INSTRUCTION,
} from "./delivery";
import {
	createWorkspaceRuns,
	managedAgentOpPolicy,
	compactRunView,
	type WorkspaceRunView,
	type WorkspaceRuns,
} from "./workspace-runs";
import { renderSubagentCall, renderSubagentResult } from "./render";
import { attachDelivery } from "./wiring";
import {
	buildSpawnModelSection,
	buildSpawnModelSectionError,
	SPAWN_MODEL_RULE,
	SPAWN_MODEL_SECTION,
} from "./spawn-guidance";
import { taskStatus } from "../task-workspace/flows";
import { resolveTaskRoot } from "../task-workspace/task-root";
import type { AgentResult, AgentSnapshot } from "./types";
import { setSubagentInspectionSource } from "./inspection-seam";
import {
	attachRunningAgentsPush,
	type RunningAgentsPush,
	type RunningAgentsPushContext,
} from "./running-agents-push";

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
	/** Steering wake poll cadence: a user message should release the wait within ~half a second. */
	steeringWakePollMs: 450,
};

// =============================================================================
// Tool schema
// =============================================================================

/** Tool parameter schema. */
function buildSubagentParams() {
	return Type.Object({
		op: StringEnum(["spawn", "status", "steer", "follow_up", "wait", "result", "respond", "cancel"] as const, {
			description: "Operation to perform on subagents (required on every call)",
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
					"spawn: run this child as the OWNER of a managed task worktree (RepoOwner mode). Blocks until terminal, needs_input, or the independent waitTimeoutSec cap (returns running); the child continues under its enforced deadline. The child runs as role `owner`: its model is `model` when given, else the `owner` role binding, else the current session model (/subagent-role)",
			}),
		),
		deadlineSec: Type.Optional(
			Type.Integer({
				description:
					"spawn (workspace only): run deadline in seconds (default 600); covers the whole run including the report ladder",
				minimum: 1,
			}),
		),
		waitTimeoutSec: Type.Optional(Type.Integer({
			description: "spawn (workspace only): max continuous Main wait in seconds (default 600), independent of deadlineSec; timeout returns running without stopping the child",
			minimum: 1, maximum: 3600,
		})),
		model: Type.Optional(
			Type.String({
				description:
					"spawn (plain and workspace): explicit child model in Pi pattern syntax `provider/id[:thinking]` (thinking: off|minimal|low|medium|high|xhigh|max). Exact registry match; an unknown model or an unsupported thinking level fails the spawn. The literal `session` means “inherit the session pair” (provider/id/thinking of this session). Omitted thinking = your current thinking level. Use when the user named a model; mutually exclusive with `role`",
			}),
		),
		role: Type.Optional(
			StringEnum(["explore", "helper", "review", "owner"] as const, {
				description:
					"spawn: model role bound per machine (see the subagent_model_defaults prompt section for the effective models; unbound = the current session model). explore = cheap read-only research, helper = generic plain subagent (plain default), review = independent fresh-context reviewer, owner = RepoOwner (workspace spawns only, always implied there). Mutually exclusive with `model`",
			}),
		),
		message: Type.Optional(Type.String({ description: "steer/follow_up: message for the child agent" })),
		answer: Type.Optional(Type.String({ description: "respond: answer to the child's pending question" })),
		idleExitMs: Type.Optional(
			Type.Integer({
				description:
					"spawn (plain only): ms after a child settles before its process is retired — the terminal result is kept (default 1800000 = 30 min; 0 disables idle exit)",
				minimum: 0,
			}),
		),
		timeoutSec: Type.Optional(
			Type.Integer({ description: "wait: max seconds to block (default 600)", minimum: 1, maximum: 3600 }),
		),
	});
}

/** Parsed tool arguments (pi's `prepareArguments` return contract). */
type SubagentArgs = Static<ReturnType<typeof buildSubagentParams>>;

/**
 * Argument pre-flight that runs on the RAW tool arguments, before the schema
 * strips unknown keys: `modelClass` was removed in favor of `role`/`model`,
 * and an old prompt must fail loudly instead of silently losing its model
 * selection. Every other argument passes through unchanged for schema
 * validation.
 */
export function prepareSubagentArguments(args: unknown): SubagentArgs {
	if (args && typeof args === "object" && (args as Record<string, unknown>).modelClass !== undefined) {
		throw new Error(
			"modelClass was removed; use role=<explore|helper|review|owner> or model=<provider/id[:thinking]>",
		);
	}
	return args as SubagentArgs;
}

// =============================================================================
// Wiring
// =============================================================================

/**
 * How the parent enumerates configured packages. Injectable so wiring tests
 * can assert the cwd/trust threading without touching pi's real managers.
 */
export interface PackageManagerWiring {
	agentDir(): string;
	createSettingsManager(cwd: string, agentDir: string, options: { projectTrusted: boolean }): unknown;
	createPackageManager(options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
	}): { listConfiguredPackages(): ConfiguredPackageRef[] };
}

const realPackageManagerWiring: PackageManagerWiring = {
	agentDir: resolveAgentDir,
	createSettingsManager: (cwd, agentDir, options) => SettingsManager.create(cwd, agentDir, options),
	createPackageManager: (options) =>
		new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager as SettingsManager,
		}),
};

/**
 * listPackages callback bound to the LIVE parent facts (cwd + project trust
 * captured from the same ctx as the model registry). The options object
 * mirrors pi's `SettingsManagerCreateOptions`: an untrusted project's
 * settings are not read at all, so its `packages` can never flow into a
 * child `-e` (that would be local code execution of untrusted content);
 * user-scope packages are unaffected.
 */
export function makeParentPackageLister(
	parent: ParentRuntimeFacts,
	wiring: PackageManagerWiring = realPackageManagerWiring,
): () => ConfiguredPackageRef[] {
	return () => {
		const agentDir = wiring.agentDir();
		return wiring
			.createPackageManager({
				cwd: parent.cwd,
				agentDir,
				settingsManager: wiring.createSettingsManager(parent.cwd, agentDir, {
					projectTrusted: parent.projectTrusted,
				}),
			})
			.listConfiguredPackages();
	};
}

/**
 * Latest session model registry — the parent-side fact for provider
 * propagation (R2) — plus the live parent facts that must travel with it.
 * Refreshed at every tool entry and session_start; a spawn always runs inside
 * a tool handler, so the snapshot is fresh when the controller resolves the
 * child's provider entries.
 */
let parentRegistry: { getRegisteredProviderIds(): readonly string[] } | undefined;
let parentFacts: ParentRuntimeFacts = { cwd: process.cwd(), projectTrusted: true };

/**
 * Capture the parent-side facts from the live extension ctx: the registry,
 * the ctx cwd of this moment, and the project trust state. cwd/trust MUST
 * come from the same ctx as the registry — a session rebind can move the
 * session to another project, and enumeration against a stale cwd would read
 * the wrong project's packages. Trust defaults to true when a ctx predates
 * the probe (mirrors pi's `options.projectTrusted ?? true`).
 */
function refreshParentFacts(ctx: {
	cwd: string;
	modelRegistry: { getRegisteredProviderIds(): readonly string[] } | undefined;
	isProjectTrusted?: () => boolean;
}): void {
	parentRegistry = ctx.modelRegistry;
	parentFacts = {
		cwd: ctx.cwd,
		projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
	};
}

/**
 * Resolve the provider extension entries a child needs for `model`
 * ("provider/id") from LIVE parent facts: the session registry decides
 * whether the provider is extension-registered at all; pi's public package
 * manager enumerates configured packages read-only (`listConfiguredPackages`:
 * no install, no update, no network) and only installed packages contribute
 * local entry paths. Needed-but-missing throws ProviderExtensionError before
 * any process exists.
 */
function resolveChildProviderEntries(model: string): string[] {
	return requireProviderExtensions(model, {
		registeredProviderIds:
			typeof parentRegistry?.getRegisteredProviderIds === "function"
				? parentRegistry.getRegisteredProviderIds()
				: [],
		listPackages: makeParentPackageLister(parentFacts),
	});
}

export default function (pi: ExtensionAPI) {
	let runtime: LocalSubagentRuntime | null = null;
	let runs: WorkspaceRuns | null = null;
	/** Running-agents push, attached when the runtime is first created. */
	let runningAgentsPush: RunningAgentsPush | null = null;
	/**
	 * Latest session_start ctx for the push gate: mode + ui. Captured per
	 * session (a session rebind may point at a different host); undefined
	 * before the first session_start, which keeps the emitter inert.
	 */
	let pushContext: RunningAgentsPushContext | undefined;
	/** Main session file for result attribution; set on session_start and lazily on tool entry. */
	let parentSessionFile: string | undefined;

	// Static tool texts enumerate the saved classes AT EXTENSION LOAD (SPEC
	// R4): built per registration so each load sees current storage, with no
	// user-storage read at module import time.
	const SubagentParams = buildSubagentParams();

	function getRuntime(ctxCwd?: string): LocalSubagentRuntime {
		if (!runtime) {
			runtime = new LocalSubagentRuntime({
				defaultCwd: ctxCwd ?? process.cwd(),
				parentSession: parentSessionFile,
				providerResolution: resolveChildProviderEntries,
				onCostChange: (total) => pi.events.emit("subagents:cost", { total }),
			});
			attachDelivery(pi, runtime);
			// Running-agents push: derived from the same registry inspect() reads,
			// emitted only in RPC mode. The creation frame goes out immediately
			// (usually the empty set) so the host sees the channel live.
			runningAgentsPush = attachRunningAgentsPush(runtime, pushContext);
		}
		return runtime;
	}

	function getRuns(): WorkspaceRuns {
		if (!runs) {
			runs = createWorkspaceRuns(pi, (ctxCwd) => getRuntime(ctxCwd));
		}
		return runs;
	}

	// The machine inspection extension reads through this seam; it never owns
	// runtime state and therefore cannot accidentally create a second registry.
	setSubagentInspectionSource({
		inspect: () => (runtime ? runtime.inspect() : []),
		view: (snapshot) => agentDetailView(snapshot, runs?.runView(snapshot.id)),
	});

	// Cost rollup: before the runtime exists, reconstruct this session's
	// settled subagent spend from persisted results (resume case — the live
	// runtime and its in-memory counters are gone). Once the runtime exists
	// it owns the total and emits `subagents:cost` itself; consumers (footer)
	// repaint on the event. Never starts the runtime: no results dir, no read.
	pi.on("session_start", async (_event, ctx) => {
		refreshParentFacts(ctx);
		parentSessionFile =
			(ctx.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.() ??
			parentSessionFile;
		// Capture the push gate/transport from THIS session (mode + ui) and let
		// a live emitter adopt it: a rebind may point at a different host, and
		// the RPC-only rule must follow the current ctx, not the creating one.
		pushContext = { mode: ctx.mode, ui: ctx.ui };
		runningAgentsPush?.updateContext(pushContext);
		if (runtime || !parentSessionFile) return;
		const total = sumSessionCost(defaultResultsDir(), parentSessionFile);
		if (total > 0) pi.events.emit("subagents:cost", { total });
	});

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
			const w = runs;
			runtime = null;
			runs = null;
			// Best-effort empty frame BEFORE the children are killed: the host
			// must not keep a stale running count once this runtime is gone.
			runningAgentsPush?.shutdown();
			runningAgentsPush = null;
			let stopped = true;
			try {
				await r.shutdown();
			} catch {
				// A shutdown that did not prove the children dead keeps their
				// worktree leases: crash recovery must verify them, not a guess.
				stopped = false;
			}
			if (stopped) w?.releaseAll();
		}
		pushContext = undefined;
		setSubagentInspectionSource(undefined);
	});

	// Fresh model-role guidance: mid-session /subagent-role changes must reach
	// Main without stale snapshots. A dedicated prompt section is rebuilt from
	// CURRENT bindings on every before_agent_start; Pi diffs
	// sections and appends a transcript delta only when the text changed, so
	// this costs nothing per turn and never replaces the whole system prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		let text: string;
		try {
			text = buildSpawnModelSection({ bindings: loadRoleBindings(rolesPath()) });
		} catch (e) {
			text = buildSpawnModelSectionError(e instanceof Error ? e.message : String(e));
		}
		(event.systemPromptOptions.sections ??= {})[SPAWN_MODEL_SECTION] = text;
	});

	// ------------------------------------------------------------------- tool

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Manage background subagents: independent pi agent processes with their own sessions. The `op` parameter is required on every call.",
			"One surface, two spawn modes. Plain spawn (cwd) starts a child in a working directory; it works in the",
			"background. Workspace spawn (workspace=<managed task worktree>) starts a child that OWNS that worktree:",
			"the call blocks until a terminal outcome (done/partial/blocked) or needs_input, with live progress in the",
			"tool call, an enforced deadline, and a structured report envelope (the child must finish by reporting).",
			"A user message or the continuous wait cap (waitTimeoutSec, default 600s) releases Main without stopping the workspace run or extending its deadline; completion arrives via event. Workspace wait continues the same run; steer queues safely between actions, never aborts a tool; follow_up is forbidden for workspace runs.",
			"Ops: spawn, status, steer (redirect a running child), follow_up (queue work for after the current run),",
			"wait (continue a bounded wait on the same plain or workspace run),",
			"result (fetch the full persisted result; workspace runs return the report envelope + Git facts), respond",
			"(answer a child's pending question), cancel (abort and terminate).",
			"Large parallel waves of children on one provider + model can hit provider 429 rate limits — mix",
			"models across a wave or keep same-model waves small.",
			"Settled children are reaped automatically after an idle delay (default 30 min; per-spawn idleExitMs): the",
			"terminal result is preserved, only the process exits. follow_up addressed at an already-reaped child",
			"degrades to a fresh spawn with the queued task — track the returned agent id.",
			"When a background child settles, you receive a short [subagent ...] event message; the child transcript",
			"is never added to your context — fetch details with op=result.",
		].join(" "),
		promptGuidelines: [
			"Use subagent op=spawn to delegate self-contained work that does not need your direct involvement, especially parallelizable or exploratory tasks.",
			"spawn (plain cwd) returns immediately; keep working or spawn more agents, then use subagent op=wait to block for a specific child when you need its outcome.",
			"Workspace spawn: dispatch independent repo owners in parallel with multiple subagent calls with workspace=<worktree> in one block. The call blocks until terminal, needs_input, or the independent wait cap (running); its JSON carries the protocol outcome in `status`, and the owner's product outcome lives in `result.status` (present only when status is done). If the user sends a message while the call blocks, it detaches early (run continues; completion arrives via event) — handle the user's message then, and use op=cancel only if they asked to stop.",
			`Spawn model selection: ${SPAWN_MODEL_RULE} The subagent_model_defaults prompt section lists each role's effective model (refreshed when bindings change). The user manages bindings with /subagent-role.`,
			"Workspace terminal results include runtime-read `git_facts` (branch, HEAD SHA, dirty paths) — never ask the model for these; trust `git_facts` over any textual self-report about repository state.",
			"When a child reports needs_input, first try to resolve the request from your own conversation and task context — do not ask the user again for information that is already known.",
			"Only if the answer is unknown, use `ask` with the child's supplied request to get the missing decision, then answer via subagent op=respond id=<...> (a plain-text answer is enough; works for both modes).",
			"If a workspace run failed or settled blocked, do not re-dispatch blindly: inspect its worktree — after dispatch there is no fallback, the repair path is a new workspace spawn whose task begins with inspecting current state.",
		],
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshParentFacts(ctx);
			parentSessionFile =
				(ctx.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.() ??
				parentSessionFile;
			const rt = getRuntime(ctx.cwd);
			const op = params.op;
			// Workspace lifecycle belongs to its registry. Wait/steer/cancel are
			// routed there; follow_up is forbidden (never restart an owner).
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
						// helpers but never another worktree owner —
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
							// model applies here exactly like on plain spawns; the
							// role is always owner (binding, else the session pair) —
							// resolution fails closed pre-dispatch.
							if (params.cwd) {
								return err("workspace spawns root the child at the worktree; `cwd` does not apply");
							}
							if (params.idleExitMs !== undefined) {
								return err(
									"idleExitMs applies to plain spawns only (workspace runs are reaped by the default idle exit after settling)",
								);
							}
							const res = await getRuns().spawnRun({
								workspace: params.workspace,
								task: params.task,
								deadlineSec: params.deadlineSec,
								waitTimeoutSec: params.waitTimeoutSec,
								signal,
								onUpdate,
								hasPendingMessages:
									typeof ctx.hasPendingMessages === "function" ? () => ctx.hasPendingMessages() : undefined,
								model: params.model,
								role: params.role,
								sessionModel: ctx.model,
								modelRegistry: ctx.modelRegistry,
								thinkingLevel: ctx.thinkingLevel,
								cwd: ctx.cwd,
							});
							return res;
						}
						if (params.deadlineSec !== undefined || params.waitTimeoutSec !== undefined) {
							return err("deadlineSec and waitTimeoutSec apply to workspace spawns only (plain spawns are managed via wait)");
						}
						// Resolve the model (explicit, or via the role binding) BEFORE
						// spawning: an unknown model, a broken binding, or an invalid
						// parameter combination fails the op without starting a child.
						const pair = resolveSpawnPair("plain", { model: params.model, role: params.role }, ctx, pi.getThinkingLevel());
						const snap = await rt.spawn({
							task: params.task,
							label: params.label,
							cwd: params.cwd,
							model: pair.model,
							thinking: pair.thinking,
							...(params.idleExitMs !== undefined ? { idleExitMs: params.idleExitMs } : {}),
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
						if (params.id && snaps.length === 0) {
							// Not live in this process (e.g. after a main restart): a
							// persisted terminal record is still a real outcome and
							// must not read as an unknown id.
							const persisted = await rt.result(params.id);
							if (!persisted) return err(`unknown agent id: ${params.id}`);
							return ok(`${persistedTerminalLine(persisted)}\n\n${formatResult(persisted)}`, {
								result: persisted,
							});
						}
						const views = new Map<string, WorkspaceRunView>();
						for (const s of snaps) {
							const v = runs?.runView(s.id);
							if (v) views.set(s.id, v);
						}
						// Full listing (no id): append foreign orphans (F003) — spawn
						// markers of OTHER sessions still "running" on disk. Never
						// rewritten here; surfaced so an operator can act on them.
						const orphans = params.id ? [] : rt.listForeignRunningMarkers();
						const text = formatStatusList(snaps, views)
							+ (orphans.length > 0 ? `\n\n${formatOrphanList(orphans)}` : "");
						return ok(text, {
							agents: snaps.map((s) => agentDetailView(s, views.get(s.id))),
							...(orphans.length > 0 ? { orphans } : {}),
						});
					}
					case "steer": {
						requireId(params);
						if (!params.message) return err("steer requires `message`");
						if (runs?.isManaged(params.id!)) await runs.steerRun(params.id!, params.message);
						else if (rt.inspect(params.id!).length > 0) await rt.steer(params.id!, params.message);
						else {
							const persisted = await rt.result(params.id!);
							if (persisted) {
								return err(
									`Subagent ${params.id} already finished (${persistedTerminalLine(persisted)}); nothing was steered.`,
								);
							}
							return err(`unknown agent id: ${params.id}`);
						}
						return ok(`Steering delivered to ${params.id}.`);
					}
					case "follow_up": {
						requireId(params);
						if (!params.message) return err("follow_up requires `message`");
						const res = await rt.followUp(params.id!, params.message);
						if (res.respawned) {
							// The child was already reaped (idle exit) or died after
							// settling: the queued work became a fresh agent. The model
							// must track the NEW id — the old one stays terminal forever.
							return ok(
								[
									`Subagent ${params.id} had already exited (settled children are reaped after their idle delay);`,
									`its terminal result is preserved. The queued task was spawned as a FRESH subagent ${res.agentId}.`,
									`Track id=${res.agentId} for status/wait/result from here on.`,
								].join("\n"),
								{ agentId: res.agentId, respawned: true },
							);
						}
						return ok(
							`Follow-up queued for ${res.agentId}; it runs after the current work (or resumes the idle agent).`,
						);
					}
					case "wait": {
						requireId(params);
						const id = params.id!;
						if (runs?.isManaged(id)) return runs.waitRun(id, {
							timeoutSec: params.timeoutSec, signal, onUpdate,
							hasPendingMessages: typeof ctx.hasPendingMessages === "function" ? () => ctx.hasPendingMessages() : undefined,
						});
						// No live run in this process: a persisted terminal record IS the
						// outcome of the wait instead of an unknown-id rejection.
						if (rt.inspect(id).length === 0) {
							const persisted = await rt.result(id);
							if (persisted) {
								// Mirror the live outcome switch below: a persisted failure is a
								// failed wait, not a successful one carrying failure text.
								if (persisted.status === "failed") {
									return err(`Subagent ${id} failed: ${persisted.failureReason ?? "failed"}`);
								}
								if (persisted.status === "cancelled") {
									return ok(`Subagent ${id} was cancelled.`, { result: persisted });
								}
								return ok(formatResult(persisted), { result: persisted });
							}
						}
						// Live progress: while blocked, periodically render a
						// truthful snapshot of the child (state, current tool,
						// bounded recent activity) into the tool call. Display-only;
						// the child transcript stays isolated.
						let progressTimer: ReturnType<typeof setInterval> | undefined;
						// Steering wake: while blocked, a pending user message (steering
						// or follow-up) releases this call early — the child keeps
						// running and its completion still arrives as the usual
						// background event, or Main re-issues wait. Plain children have
						// no detach/ownership concept, so this is a release, not a
						// detach. Own deliveries are suppressed via ./steering-wake.
						const pendingProbe =
							typeof ctx.hasPendingMessages === "function" ? () => ctx.hasPendingMessages() : undefined;
						// The wake abort only RELEASES the runtime waiter (its timeout-
						// shaped outcome is discarded) — it must not surface to the
						// switch below as a timeout.
						const wakeAbort = new AbortController();
						const onToolAbort = () => wakeAbort.abort();
						signal?.addEventListener("abort", onToolAbort, { once: true });
						let wakeTimer: ReturnType<typeof setInterval> | undefined;
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
							const outcome = await new Promise<WaitOutcome>((resolve, reject) => {
								let done = false;
								const finish = (o: WaitOutcome) => {
									if (done) return;
									done = true;
									if (wakeTimer) {
										clearInterval(wakeTimer);
										wakeTimer = undefined;
									}
									resolve(o);
								};
								// rt.wait is async: unknown/workspace ids reject the promise
								// (never a sync throw) — forward the rejection so the tool
								// surfaces it exactly like a bare await would.
								rt.wait(id, {
									timeoutMs: (params.timeoutSec ?? CONFIG.waitTimeoutSec) * 1000,
									signal: wakeAbort.signal,
								}).then(finish, reject);
								if (!pendingProbe) return;
								wakeTimer = setInterval(() => {
									if (ownDeliveryInFlight()) return;
									try {
										if (!pendingProbe()) return;
									} catch {
										return; // a broken probe must never break the wait
									}
									// Release the runtime waiter FIRST so it cannot
									// consume the completion event that belongs to
									// the background delivery; then report the release.
									wakeAbort.abort();
									const snap = rt.inspect(id)[0];
									finish({ status: "released", state: snap?.state ?? "running" });
								}, CONFIG.steeringWakePollMs);
								wakeTimer.unref?.();
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
								case "released":
									return ok(
										[
											`wait released: the user sent a message while Main was blocked on subagent ${id}.`,
											`The subagent is still ${outcome.state} and keeps running in the background; its completion`,
											`still arrives as the usual [subagent ...] event, or re-issue op=wait.`,
										].join("\n"),
										{ wait: outcome },
									);
							}
							break;
						} finally {
							// The progress and wake loops die on EVERY exit: outcome,
							// timeout, abort, wake, and thrown errors. No leaked timers,
							// no updates after the tool call settled.
							if (progressTimer) clearInterval(progressTimer);
							if (wakeTimer) clearInterval(wakeTimer);
							signal?.removeEventListener("abort", onToolAbort);
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
									JSON.stringify({ status: view.state === "waiting_input" ? "needs_input" : "running", agentId: params.id, dispatched: true, ...compactRunView(view) }),
									{ run: compactRunView(view) },
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
						if (runs?.isManaged(params.id!)) await runs.cancelRun(params.id!);
						else if (rt.inspect(params.id!).length > 0) await rt.cancel(params.id!);
						else {
							const persisted = await rt.result(params.id!);
							if (persisted) {
								return ok(
									`Subagent ${params.id} already finished (${persistedTerminalLine(persisted)}); nothing to cancel.`,
								);
							}
							return err(`unknown agent id: ${params.id}`);
						}
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

	pi.registerCommand("subagent-role", {
		description: "Show or change which model each subagent role (explore, helper, review, owner) uses on this machine",
		getArgumentCompletions: (prefix: string) => {
			const items = roleCommandCompletions(prefix).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const result = runRoleCommand(args, {
				file: rolesPath(),
				model: ctx.model ?? undefined,
				thinking: pi.getThinkingLevel(),
				registry: ctx.modelRegistry.getAll(),
			});
			ctx.ui.notify(result.text, result.kind);
		},
	});

	pi.registerCommand("agentkit-status", {
		description:
			"Deprecated compatibility read for external RPC controllers (model-free; args: subagents | task | all, default all)",
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
			const snapshots = runtime.inspect();
			const views = new Map<string, WorkspaceRunView>();
			for (const s of snapshots) { const view = runs?.runView(s.id); if (view) views.set(s.id, view); }
			ctx.ui.notify(formatStatusList(snapshots, views), "info");
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

/** One-line identity of a persisted terminal record, shared by the
 *  status/steer/cancel fallbacks that run when no live record exists. */
function persistedTerminalLine(result: AgentResult): string {
	const reason =
		result.status === "failed"
			? result.failureReason ?? "failed"
			: result.status === "cancelled"
				? "cancelled"
				: result.summary ?? "completed";
	return `No live run in this process; persisted terminal record: ${result.status} — ${reason}. Full record via op=result.`;
}

function clipSnapshot(s: ReturnType<LocalSubagentRuntime["inspect"]>[number]) {
	return { ...s, task: s.task.length > 200 ? `${s.task.slice(0, 200)}…` : s.task };
}

/**
 * One agent's structured status detail: the clipped snapshot plus, for a
 * run-owned (workspace) agent, a compact view of its run. The single mapping
 * behind `subagent op=status`, `agentkit-status` and inherited inspection,
 * so the surfaces cannot drift. Terminal projection includes only runtime status,
 * reason and product status/summary (full outcomes stay on `subagent op=result`).
 */
export function agentDetailView(s: AgentSnapshot, view?: WorkspaceRunView) {
	return view
		? {
				...clipSnapshot(s),
				run: compactRunView(view),
			}
		: clipSnapshot(s);
}
