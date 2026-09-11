/**
 * Workspace layer — the RepoOwner contract on top of the subagent primitive.
 *
 * One shared SubagentRuntime stays the owner of all child processes; this
 * module is the second policy surface inside the same extension (jiti loads
 * each extension entry with a private module cache, so cross-extension
 * sharing is impossible by construction). RepoOwner children are spawned with
 * a per-spawn profile (task-workspace binding + reporting bridge), their
 * lifecycle events are routed here by the controller's event router, and the
 * generic `subagent` policy never sees them.
 *
 * Contract (see SPEC §3):
 * - fail closed before dispatch (model pinning, workspace validation, static
 *   preflight, readiness handshake — the task prompt never reaches a model
 *   before the child proves initialization);
 * - no fallback after dispatch (abort = detach; repair = a new RepoOwner);
 * - deadline covers the whole run including the report ladder;
 * - settlement accepts only a fresh report_result envelope (staleness is
 *   enforced by the reporting bridge); terminal outcomes retire the child
 *   while preserving its record;
 * - durable query: `workspace_agent(run_id)` returns any run's state or
 *   terminal envelope for the rest of the main session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	envelopeFileName,
	validateEnvelopeRecord,
	type Envelope,
	type EnvelopeRecord,
} from "./envelope";
import { REPORTING_ENTRY_ID } from "./reporting-bridge";
import { expandPath, git, isLinkedWorktree, realpath } from "../task-workspace/git";
import { formatNeedsInputBody } from "./delivery";
import type { AgentResult, AgentSnapshot, SpawnOptions, SubagentModelEvent } from "./types";
import type { AskInput } from "../ask/contract";

// ============================================================ configuration

/** Entry id of the task-workspace extension inside the child profile. */
const TASK_WORKSPACE_ENTRY_ID = "task-workspace";

/** Tools each profile entry must report as registered (readiness contract). */
const PROFILE_READINESS: Record<string, string[]> = {
	[TASK_WORKSPACE_ENTRY_ID]: [
		"task_status",
		"ensure_task_repo",
		"checkpoint_commit",
		"remove_task_lane",
	],
	[REPORTING_ENTRY_ID]: ["report_result"],
};

/** Report ladder depth: at most this many follow-ups before `blocked`. */
const LADDER_MAX = 3;

const DEFAULT_TIMEOUT_MS = 600000;

// ================================================================ run model

export type ExternalStatus =
	| "done"
	| "partial"
	| "blocked"
	| "unsupported"
	| "needs_input"
	| "error"
	| "running";

/** Query-only status for a run that has not reached a terminal outcome. */
export type InProgressStatus = "running";

interface TerminalOutcome {
	status: "done" | "partial" | "blocked";
	reason?: string;
	result?: Envelope;
	lastOutput?: string;
	childMayHaveMutatedRepo: boolean;
}

interface WorkspaceAgentRun {
	runId: string;
	agentId: string;
	workspace: string;
	task: string;
	deadline: number;
	startedAt: number;
	state: "running" | "waiting_input" | "settling" | "terminating";
	question?: string;
	/** Structured canonical request behind `question` (needs_input only). */
	request?: AskInput;
	ladder: number;
	/** Highest report generation seen from the child; a newer one resets the ladder. */
	lastSeenGeneration: number;
	terminal?: TerminalOutcome;
	deadlineFired: boolean;
	deadlineTimer?: NodeJS.Timeout;
	waiters: Array<(outcome: "settled" | "needs_input" | "detached") => void>;
}

export interface DispatchResult {
	status: ExternalStatus;
	dispatched: boolean;
	workspace: string;
	agentId?: string;
	runId?: string;
	state?: string;
	question?: string;
	/** Structured canonical ask request when status is needs_input. */
	request?: AskInput;
	deadlineMsLeft?: number;
	result?: Envelope;
	summary?: string;
	last_output?: string;
	reason?: string;
	child_may_have_mutated_repo?: boolean;
}

export interface WorkspaceLayer {
	/** True when the agent id belongs to a workspace-routed RepoOwner. */
	isManagedAgent(agentId: string): boolean;
}

/**
 * Cross-tool allow-list for RepoOwner children on the `subagent` tool.
 * status/result/respond/cancel stay available to Main; wait would steal the
 * one lifecycle event from the workspace registry, steer/follow_up would
 * bypass the run's deadline and task contract.
 */
export function managedAgentOpPolicy(op: string): { allowed: boolean; reason?: string } {
	switch (op) {
		case "wait":
			return {
				allowed: false,
				reason:
					"wait is not allowed for workspace_agent runs (workspace-owned agent): lifecycle events belong to the workspace registry — use workspace_agent(run_id) query-mode",
			};
		case "steer":
		case "follow_up":
			return {
				allowed: false,
				reason: `${op} is not allowed for workspace_agent runs (workspace-owned agent): it would bypass the run's deadline and task contract`,
			};
		default:
			return { allowed: true };
	}
}

/** Minimal slice of the tool-execute context the layer needs. */
export interface DispatchContext {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	cwd?: string;
}

/**
 * Runtime subset the workspace layer needs. LocalSubagentRuntime satisfies
 * this structurally; the interface keeps the runtime swappable in tests and
 * documents that the layer never creates controllers itself (SPEC D1).
 */
export interface WorkspaceAgentRuntime {
	spawn(opts: SpawnOptions): Promise<AgentSnapshot>;
	followUp(agentId: string, message: string): Promise<void>;
	respond(agentId: string, answer: string): Promise<void>;
	cancel(agentId: string): Promise<void>;
	retire(agentId: string): Promise<void>;
	inspect(agentId?: string): AgentSnapshot[];
	result(agentId: string): Promise<AgentResult | null>;
	onWorkspaceEvent(cb: (ev: SubagentModelEvent) => void): () => void;
	isWorkspaceRouted(agentId: string): boolean;
	getResultsDir(): string;
}

// ==================================================================== layer

export interface WorkspaceLayerOptions {
	/** Override the profile entrypoint paths (tests: point at missing files). */
	profileEntries?: () => string[];
}

export function createWorkspaceLayer(
	pi: ExtensionAPI,
	getRuntime: (ctxCwd: string | undefined) => WorkspaceAgentRuntime,
	opts?: WorkspaceLayerOptions,
): WorkspaceLayer {
	const runsByRunId = new Map<string, WorkspaceAgentRun>();
	const runsByAgentId = new Map<string, WorkspaceAgentRun>();
	let runCounter = 0;

	// The runtime is created lazily by the host (F1: the workspace_agent tool
	// is registered eagerly here, before any subagent tool call), but children
	// can only exist after the layer acquired the runtime. Once acquired, bind
	// it and subscribe the single event-ownership handler exactly once.
	let boundRt: WorkspaceAgentRuntime | undefined;
	const R = (ctxCwd: string | undefined): WorkspaceAgentRuntime => {
		const rt = getRuntime(ctxCwd);
		if (rt !== boundRt) {
			boundRt = rt;
			rt.onWorkspaceEvent((ev) => {
				try {
					void handleEvent(ev);
				} catch {
					// settlement must never crash the runtime event path
				}
			});
		}
		return rt;
	};

	const taskRoot = realpath(process.env.OMP_TASK_ROOT ?? path.join(os.homedir(), ".omp", "tasks"));

	/** The bound runtime (events and settlement only run after a dispatch bound it). */
	const rt = (): WorkspaceAgentRuntime => {
		if (!boundRt) return R(undefined);
		return boundRt;
	};

	// ---------------------------------------------------------------- events

	async function handleEvent(ev: SubagentModelEvent): Promise<void> {
		const run = runsByAgentId.get(ev.agentId);
		if (!run) return;
		switch (ev.kind) {
			case "needs_input":
				// Non-terminal: the child is suspended on ask. A blocking
				// dispatch call (if any is still waiting) consumes the question;
				// otherwise — after the first dispatch returned, or after a
				// detach — Main must be told, or the run would silently hang
				// until the deadline. The deadline keeps ticking either way.
				run.state = "waiting_input";
				run.question = ev.question;
				run.request = ev.request;
				if (run.waiters.length > 0) {
					resolveWaiters(run, "needs_input");
				} else {
					notifyNeedsInput(run);
				}
				break;
			case "input_resolved":
				// The pending ask was answered (respond) or aborted child-side:
				// the run is no longer waiting for Main.
				run.state = "running";
				run.question = undefined;
				run.request = undefined;
				break;
			case "completed":
				await settle(run, "completed");
				break;
			case "failed":
				await settle(run, "failed");
				break;
			case "cancelled":
				// Semantic cancel: deadline (already handled by its own path)
				// or explicit cancel by Main. The child is already dead when
				// this arrives.
				if (run.terminal || run.deadlineFired) return;
				finish(run, {
					status: "blocked",
					reason: "cancelled_by_main",
					lastOutput: await lastOutput(run.agentId),
					childMayHaveMutatedRepo: true,
				});
				break;
		}
	}

	// ------------------------------------------------------------ settlement

	async function settle(run: WorkspaceAgentRun, childOutcome: "completed" | "failed"): Promise<void> {
		if (run.terminal || run.state === "settling") return;
		run.state = "settling";
		const record = readEnvelopeRecord(run.agentId);
		// A newer report generation means the child reported again: the ladder
		// resets BEFORE the stale/fresh classification (fresh report → new
		// ladder budget, even if a later tool call already invalidated it).
		if (record && record.generation > run.lastSeenGeneration) {
			run.lastSeenGeneration = record.generation;
			run.ladder = 0;
		}
		if (record && !record.stale) {
			// Trusted fresh envelope: the product outcome, delivered as done.
			// CLAIM the terminal outcome atomically before the (possibly slow)
			// retire: the deadline must not fire mid-retire and turn the
			// already-decided done into a cancel/partial. After the claim the
			// deadline timer is dead; first claimer wins the run outcome.
			if (run.terminal) return;
			run.deadlineFired = true;
			if (run.deadlineTimer) {
				clearTimeout(run.deadlineTimer);
				run.deadlineTimer = undefined;
			}
			// Terminal lifecycle (F4): the completion is published only after
			// the settled child is actually gone.
			await retireChild(run);
			finish(run, {
				status: "done",
				result: record.envelope,
				childMayHaveMutatedRepo: false,
			});
			return;
		}
		const deadlinePassed = Date.now() >= run.deadline;
		if (childOutcome === "completed" && !deadlinePassed && run.ladder < LADDER_MAX) {
			// Protocol recovery ladder: the child settled without a fresh
			// report. Follow-ups are allowed; they consume the ladder.
			run.ladder += 1;
			run.state = "running";
			try {
				await rt().followUp(run.agentId, ladderMessage(run.ladder));
			} catch {
				if (!run.terminal && !run.deadlineFired) {
					await retireChild(run);
					finish(run, {
						status: "blocked",
						reason: "report_ladder_delivery_failed",
						lastOutput: await lastOutput(run.agentId),
						childMayHaveMutatedRepo: true,
					});
				}
			}
			return;
		}
		const last = await lastOutput(run.agentId);
		if (childOutcome === "completed") {
			if (deadlinePassed) {
				await retireChild(run);
				finish(run, {
					status: "partial",
					reason: "deadline",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			} else {
				await retireChild(run);
				finish(run, {
					status: "blocked",
					reason: "no_valid_report",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			}
			return;
		}
		// Child run failed without a fresh envelope: no trusted outcome exists.
		await retireChild(run);
		finish(run, {
			status: "blocked",
			reason: childOutcome === "failed" ? "child_failed" : "child_cancelled",
			lastOutput: last,
			childMayHaveMutatedRepo: true,
		});
	}

	function ladderMessage(step: number): string {
		if (step < LADDER_MAX) {
			return (
				`Your run settled but no fresh report_result envelope was found ` +
				`(protocol check ${step} of ${LADDER_MAX}). Call report_result now with your ` +
				`final structured outcome, as your only remaining action.`
			);
		}
		return (
			`Final reminder: call report_result NOW, as your only remaining action, ` +
			`with your final structured outcome — otherwise the run settles as blocked.`
		);
	}

	function finish(run: WorkspaceAgentRun, outcome: TerminalOutcome): void {
		if (run.terminal) return;
		run.terminal = outcome;
		if (run.deadlineTimer) clearTimeout(run.deadlineTimer);
		resolveWaiters(run, "settled");
		notifyCompleted(run);
	}

	/**
	 * RepoOwner suspended on ask with NO blocking dispatch waiter left
	 * (first dispatch already returned, or Main detached): tell Main, or
	 * the run would silently hang until the deadline.
	 */
	function notifyNeedsInput(run: WorkspaceAgentRun): void {
		const lines = [
			`[workspace_agent needs_input]`,
			`runId: ${run.runId}`,
			`agentId: ${run.agentId}`,
			`workspace: ${run.workspace}`,
			...formatNeedsInputBody(run.question ?? "(unknown)", run.request),
			`answer via subagent op=respond id=${run.agentId} answer=<...>; the run resumes under the same deadline`,
			`details via workspace_agent(run_id: "${run.runId}")`,
		];
		try {
			pi.sendMessage(
				{
					customType: "workspace-agent-event",
					content: lines.join("\n"),
					display: true,
					details: { runId: run.runId, agentId: run.agentId, kind: "needs_input" },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// Query-mode remains the recovery path if delivery fails.
		}
	}

	/** Terminal lifecycle: kill the settled child, keep the terminal record. */
	async function retireChild(run: WorkspaceAgentRun): Promise<void> {
		try {
			await rt().retire(run.agentId);
		} catch {
			// already dead — the record stays as settled
		}
	}

	function notifyCompleted(run: WorkspaceAgentRun): void {
		const o = run.terminal!;
		const lines = [
			`[workspace_agent completed]`,
			`runId: ${run.runId}`,
			`agentId: ${run.agentId}`,
			`workspace: ${run.workspace}`,
			`status: ${o.status}`,
		];
		if (o.status === "done" && o.result) {
			lines.push(`result: ${JSON.stringify(o.result)}`);
		}
		if (o.reason) lines.push(`reason: ${o.reason}`);
		if (o.childMayHaveMutatedRepo) lines.push(`child_may_have_mutated_repo: true`);
		lines.push(`details via workspace_agent(run_id: "${run.runId}")`);
		try {
			pi.sendMessage(
				{
					customType: "workspace-agent-event",
					content: lines.join("\n"),
					display: true,
					details: { runId: run.runId, agentId: run.agentId, kind: "completed", status: o.status },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// Delivery loss is survivable by design: the run stays queryable.
		}
	}

	function resolveWaiters(run: WorkspaceAgentRun, outcome: "settled" | "needs_input" | "detached"): void {
		for (const w of run.waiters.splice(0)) w(outcome);
	}

	// -------------------------------------------------------------- deadline

	function armDeadline(run: WorkspaceAgentRun): void {
		const remaining = Math.max(0, run.deadline - Date.now());
		run.deadlineTimer = setTimeout(() => {
			if (run.terminal || run.deadlineFired) return;
			run.deadlineFired = true;
			// Publish the terminal outcome only AFTER the child actually
			// stopped (F4): Main must not start inspection/repair against a
			// child that is still running. Semantic cancel — the real
			// cancel, never retire: the child did not settle into a trusted
			// outcome.
			run.state = "terminating";
			void (async () => {
				try {
					await rt().cancel(run.agentId);
				} catch {
					// cancel escalation is best-effort; the run outcome stands
				}
				const last = await lastOutput(run.agentId).catch(() => undefined);
				finish(run, {
					status: "partial",
					reason: "deadline",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			})();
		}, remaining);
		run.deadlineTimer.unref?.();
	}

	// -------------------------------------------------------------- envelope

	function envelopeFilePath(agentId: string): string {
		return path.join(rt().getResultsDir(), envelopeFileName(agentId));
	}

	function readEnvelopeRecord(agentId: string): EnvelopeRecord | undefined {
		try {
			const raw = fs.readFileSync(envelopeFilePath(agentId), "utf8");
			return validateEnvelopeRecord(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}

	/** Best-effort last visible output of the child (error or final text). */
	async function lastOutput(agentId: string): Promise<string | undefined> {
		const snap = rt().inspect(agentId)[0];
		if (snap?.lastError) return snap.lastError;
		try {
			const res = await rt().result(agentId);
			const text = res?.finalText?.trim();
			if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
		} catch {
			// fall through
		}
		return undefined;
	}

	// ------------------------------------------------------------ validation

	class WorkspaceValidationError extends Error {
		constructor(
			public readonly kind: "unsupported" | "blocked",
			message: string,
		) {
			super(message);
		}
	}

	async function validateWorkspace(workspace: string): Promise<string> {
		const expanded = expandPath(workspace, process.cwd());
		if (!expanded || expanded === "/" ) {
			throw new WorkspaceValidationError("unsupported", `workspace path is empty: ${workspace}`);
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(expanded);
		} catch {
			throw new WorkspaceValidationError("unsupported", `workspace does not exist: ${workspace}`);
		}
		if (!stat.isDirectory()) {
			throw new WorkspaceValidationError("unsupported", `workspace is not a directory: ${workspace}`);
		}
		const real = realpath(expanded);
		if (!isLinkedWorktree(real)) {
			throw new WorkspaceValidationError(
				"unsupported",
				`workspace is not a linked git worktree (.git must be a gitdir: file): ${workspace}`,
			);
		}
		const rel = path.relative(taskRoot, real);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new WorkspaceValidationError(
				"unsupported",
				`workspace is not under the task root (${taskRoot}): ${workspace}`,
			);
		}
		const toplevel = await git(real, "rev-parse", "--show-toplevel");
		if (!toplevel.ok) {
			throw new WorkspaceValidationError("unsupported", `workspace is not a git repository: ${workspace}`);
		}
		const toplevelReal = realpath(toplevel.stdout.trim());
		if (toplevelReal !== real) {
			throw new WorkspaceValidationError(
				"unsupported",
				`workspace git toplevel mismatch (canonical invariant): ${toplevelReal} != ${real}`,
			);
		}
		return real;
	}

	function staticPreflight(): void {
		for (const ext of profileEntries()) {
			try {
				fs.accessSync(ext, fs.constants.R_OK);
			} catch {
				throw new WorkspaceValidationError(
					"unsupported",
					`required profile extension is missing or unreadable: ${ext}`,
				);
			}
		}
	}

	function profileEntries(): string[] {
		if (opts?.profileEntries) return opts.profileEntries();
		return defaultProfileEntries(moduleDirname());
	}

	// ----------------------------------------------------------------- tool

	pi.registerTool({
		name: "workspace_agent",
		label: "Workspace Agent",
		description:
			"Run a RepoOwner agent rooted in a managed task worktree. Dispatch-mode: workspace_agent(workspace, task, " +
			"timeout_ms?) blocks until a terminal outcome (done/partial/blocked) or needs_input; strict validation and " +
			"readiness happen before dispatch (fail closed), and there is no fallback after dispatch — abort detaches " +
			"and the run keeps going. Query-mode: workspace_agent(run_id) returns the current state (running / needs_input) or the terminal " +
			"envelope of any run of this session (completion events are notifications, not the only API).",
		parameters: Type.Object({
			workspace: Type.Optional(
				Type.String({ description: "Dispatch-mode: absolute managed task worktree path (the RepoOwner's cwd)" }),
			),
			task: Type.Optional(Type.String({ description: "Dispatch-mode: the task prompt for the RepoOwner" })),
			timeout_ms: Type.Optional(
				Type.Integer({
					description: `Dispatch-mode: run deadline in ms (default ${DEFAULT_TIMEOUT_MS}); covers the whole run including the report ladder`,
					minimum: 1000,
				}),
			),
			run_id: Type.Optional(
				Type.String({
					description:
						"Query-mode: runId (or agentId) from any earlier dispatch/query response; returns state or terminal envelope",
				}),
			),
		}),
		promptGuidelines: [
			"Dispatch independent repo owners in parallel with multiple workspace_agent calls in one block.",
			"The result JSON carries the protocol outcome in `status`; the RepoOwner's product outcome lives in `result.status` (present only when external status is done).",
			"needs_input suspends the run without finishing it: answer via subagent op=respond (allowed for RepoOwners); the run continues under the same deadline.",
			"If a RepoOwner failed, do not re-dispatch blindly: inspect its worktree — after dispatch there is no fallback, the repair path is a new RepoOwner with inspection.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Bind the runtime (lazy in the host) for whichever mode runs.
			R(ctx.cwd);
			// Query-mode: durable lookup by runId or agentId.
			if (params.run_id) {
				return queryRun(params.run_id);
			}
			if (!params.workspace || !params.task) {
				return err("dispatch-mode requires `workspace` and `task` (or `run_id` for query-mode)");
			}
			return dispatch(params.workspace, params.task, params.timeout_ms, signal, ctx);
		},
	});

	// -------------------------------------------------------------- dispatch

	type ToolResult = {
		content: [{ type: "text"; text: string }];
		details: DispatchResult | Record<string, unknown>;
		isError?: boolean;
	};

	async function dispatch(
		workspace: string,
		task: string,
		timeoutMs: number | undefined,
		signal: AbortSignal | undefined,
		ctx: DispatchContext,
	): Promise<ToolResult> {
		// Pre-dispatch gate 1: model pinning — no silent defaults.
		if (!ctx.model) {
			return fail("blocked", workspace, "no model resolved in the current session (refusing to use a silent default)");
		}
		// Pre-dispatch gate 2: workspace validation.
		let realWorkspace: string;
		try {
			realWorkspace = await validateWorkspace(workspace);
		} catch (e) {
			if (e instanceof WorkspaceValidationError) return fail(e.kind, workspace, e.message);
			return fail("error", workspace, e instanceof Error ? e.message : String(e));
		}
		// Pre-dispatch gate 3: static entrypoint preflight.
		try {
			staticPreflight();
		} catch (e) {
			if (e instanceof WorkspaceValidationError) return fail(e.kind, workspace, e.message);
			return fail("error", workspace, e instanceof Error ? e.message : String(e));
		}

		// Dispatch: readiness handshake + prompt acceptance happen inside
		// spawn(); it resolves only after the child accepted the task prompt,
		// and rejects (child killed, prompt never sent) on any readiness or
		// startup failure. This is the dispatch point: everything before is
		// dispatched:false, everything after is dispatched:true forever.
		const base = path.basename(realWorkspace);
		let snap: AgentSnapshot;
		try {
			snap = await R(ctx.cwd).spawn({
				task,
				label: `owner-${base}`,
				cwd: realWorkspace,
				model: `${ctx.model.provider}/${ctx.model.id}`,
				thinking: ctx.thinkingLevel,
				additionalExtensions: profileEntries(),
				readinessEntries: PROFILE_READINESS,
				eventRoute: "workspace",
				signal,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// SPEC 3.2: an abort before the task prompt was accepted means no
			// process and no task — blocked, dispatched:false. (If acceptance
			// won the race, spawn resolved and the signal's ownership moved to
			// the detach wait below.)
			if (message.includes("aborted before dispatch")) {
				return fail("blocked", workspace, message);
			}
			// Pre-dispatch startup failures are classified (SPEC A2c/A10): a
			// broken/missing extension, a dead child, or a rejected/timed-out
			// prompt all mean "this profile cannot run here" → unsupported, the
			// Main-side fallback signal. Only genuinely unclassified wrapper
			// failures surface as error.
			const startupFailure =
				message.includes("readiness handshake") ||
				message.includes("exited before accepting") ||
				message.includes("spawn error") ||
				message.includes("did not accept the initial prompt") ||
				message.includes("initial prompt rejected") ||
				message.includes("child failed to start");
			return fail(startupFailure ? "unsupported" : "error", workspace, message);
		}

		const runId = `wr-${++runCounter}-${Math.random().toString(36).slice(2, 6)}`;
		const run: WorkspaceAgentRun = {
			runId,
			agentId: snap.id,
			workspace: realWorkspace,
			task,
			deadline: Date.now() + Math.max(1000, timeoutMs ?? DEFAULT_TIMEOUT_MS),
			startedAt: Date.now(),
			state: "running",
			ladder: 0,
			lastSeenGeneration: 0,
			deadlineFired: false,
			waiters: [],
		};
		runsByRunId.set(runId, run);
		runsByAgentId.set(snap.id, run);
		armDeadline(run);

		// Blocking wait: terminal or needs_input. Abort = detach (the run
		// keeps going; completion arrives as an event / via query-mode).
		const waitOutcome = await new Promise<"settled" | "needs_input" | "detached">((resolve) => {
			const w = (outcome: "settled" | "needs_input" | "detached") => {
				// Self-remove: a detached/resolved waiter must not linger in the
				// run's waiter list (it would swallow later needs_input
				// notifications that Main still has to see).
				const idx = run.waiters.indexOf(w);
				if (idx !== -1) run.waiters.splice(idx, 1);
				cleanup();
				resolve(outcome);
			};
			run.waiters.push(w);
			const onAbort = () => w("detached");
			function cleanup() {
				signal?.removeEventListener("abort", onAbort);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			// The abort may have fired while spawn was still resolving
			// (acceptance won the race): detach immediately.
			if (signal?.aborted) w("detached");
		});

		if (waitOutcome === "detached") {
			return ok({
				status: run.terminal ? run.terminal.status : "running",
				dispatched: true,
				workspace: realWorkspace,
				agentId: run.agentId,
				runId,
				state: run.state,
				deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
				...(run.terminal
					? {}
					: { reason: "detached by main abort; the run continues under its deadline — completion arrives as [workspace_agent completed] or via workspace_agent(run_id)" }),
			});
		}
		return ok(runResult(run));
	}

	// ----------------------------------------------------------------- query

	function queryRun(key: string): ToolResult {
		const run = runsByRunId.get(key) ?? runsByAgentId.get(key);
		if (!run) {
			return err(`unknown run id: ${key} (runs live for the current main session only)`);
		}
		return ok(runResult(run));
	}

	function runResult(run: WorkspaceAgentRun): DispatchResult {
		const base: DispatchResult = {
			status: "blocked",
			dispatched: true,
			workspace: run.workspace,
			agentId: run.agentId,
			runId: run.runId,
		};
		if (run.terminal) {
			return {
				...base,
				status: run.terminal.status,
				result: run.terminal.result,
				reason: run.terminal.reason,
				last_output: run.terminal.lastOutput,
				child_may_have_mutated_repo: run.terminal.childMayHaveMutatedRepo,
			};
		}
		if (run.state === "waiting_input") {
			return {
				...base,
				status: "needs_input",
				state: run.state,
				question: run.question,
				...(run.request ? { request: run.request } : {}),
				deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
			};
		}
		// Query-only in-progress status: never returned by the blocking
		// dispatch (which resolves only on terminal/needs_input), so the
		// shared orchestration rule "partial/blocked means inspect + repair"
		// cannot be triggered by a merely running owner.
		return {
			...base,
			status: "running",
			state: run.state,
			deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
		};
	}

	// --------------------------------------------------------------- helpers

	function fail(status: "blocked" | "unsupported" | "error", workspace: string, reason: string): ToolResult {
		return ok({ status, dispatched: false, workspace, reason });
	}

	function ok(result: DispatchResult): ToolResult {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: result,
		};
	}

	function err(text: string): ToolResult {
		return {
			content: [{ type: "text" as const, text: `Error: ${text}` }],
			details: { error: text },
			isError: true,
		};
	}

	return { isManagedAgent: (agentId: string) => runsByAgentId.has(agentId) };
}

// -------------------------------------------------------------------- helpers

/**
 * Additional-extension load order for the RepoOwner profile. ORDER MATTERS:
 * the reporting bridge must come BEFORE task-workspace so its tool_call
 * staleness hook runs first — pi dispatches tool_call handlers in extension
 * order and stops at the first block, so a blocked call (e.g. the mutation
 * guard refusing a raw no-verify commit) must already have invalidated the
 * previous report_result envelope.
 */
export function defaultProfileEntries(moduleDir: string): string[] {
	return [
		path.join(moduleDir, "reporting-bridge.ts"),
		path.join(moduleDir, "..", "task-workspace", "index.ts"),
	];
}

/** Directory of this module (works under jiti and node). */
function moduleDirname(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return __dirname;
	}
}
