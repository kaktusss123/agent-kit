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
import type { LocalSubagentRuntime } from "./controller";
import type { AgentSnapshot, SubagentModelEvent } from "./types";

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

export type ExternalStatus = "done" | "partial" | "blocked" | "unsupported" | "needs_input" | "error";

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
	state: "running" | "waiting_input" | "settling";
	question?: string;
	ladder: number;
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

/** Minimal slice of the tool-execute context the layer needs. */
export interface DispatchContext {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

// ==================================================================== layer

export function createWorkspaceLayer(pi: ExtensionAPI, runtime: LocalSubagentRuntime): WorkspaceLayer {
	const runsByRunId = new Map<string, WorkspaceAgentRun>();
	const runsByAgentId = new Map<string, WorkspaceAgentRun>();
	let runCounter = 0;

	const taskRoot = realpath(process.env.OMP_TASK_ROOT ?? path.join(os.homedir(), ".omp", "tasks"));

	// Single event-ownership surface: RepoOwner lifecycle events arrive here
	// and nowhere else (the controller routes them away from the generic
	// policy, and wait() is locked for workspace children).
	runtime.onWorkspaceEvent((ev) => {
		try {
			void handleEvent(ev);
		} catch {
			// settlement must never crash the runtime event path
		}
	});

	// ---------------------------------------------------------------- events

	async function handleEvent(ev: SubagentModelEvent): Promise<void> {
		const run = runsByAgentId.get(ev.agentId);
		if (!run) return;
		switch (ev.kind) {
			case "needs_input":
				// Non-terminal: the child is suspended on ask_parent. The
				// blocking dispatch call returns; deadline keeps ticking.
				run.state = "waiting_input";
				run.question = ev.question;
				resolveWaiters(run, "needs_input");
				break;
			case "completed":
				await settle(run, "completed");
				break;
			case "failed":
				await settle(run, "failed");
				break;
			case "cancelled":
				// Semantic cancel: deadline (already handled by its own path)
				// or explicit cancel by Main.
				if (run.terminal || run.deadlineFired) return;
				finish(run, {
					status: "blocked",
					reason: "cancelled_by_main",
					lastOutput: await lastOutput(run.agentId),
					childMayHaveMutatedRepo: true,
				});
				retire(run);
				break;
		}
	}

	// ------------------------------------------------------------ settlement

	async function settle(run: WorkspaceAgentRun, childOutcome: "completed" | "failed"): Promise<void> {
		if (run.terminal || run.state === "settling") return;
		run.state = "settling";
		const record = readEnvelopeRecord(run.agentId);
		if (record && !record.stale) {
			// Trusted fresh envelope: the product outcome, delivered as done.
			finish(run, {
				status: "done",
				result: record.envelope,
				childMayHaveMutatedRepo: false,
			});
			retire(run);
			return;
		}
		const deadlinePassed = Date.now() >= run.deadline;
		if (childOutcome === "completed" && !deadlinePassed && run.ladder < LADDER_MAX) {
			// Protocol recovery ladder: the child settled without a fresh
			// report. Follow-ups are allowed; they consume the ladder.
			run.ladder += 1;
			run.state = "running";
			try {
				await runtime.followUp(run.agentId, ladderMessage(run.ladder));
			} catch {
				if (!run.terminal && !run.deadlineFired) {
					finish(run, {
						status: "blocked",
						reason: "report_ladder_delivery_failed",
						lastOutput: await lastOutput(run.agentId),
						childMayHaveMutatedRepo: true,
					});
					retire(run);
				}
			}
			return;
		}
		const last = await lastOutput(run.agentId);
		if (childOutcome === "completed") {
			if (deadlinePassed) {
				finish(run, {
					status: "partial",
					reason: "deadline",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			} else {
				finish(run, {
					status: "blocked",
					reason: "no_valid_report",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			}
			retire(run);
			return;
		}
		// Child run failed without a fresh envelope: no trusted outcome exists.
		finish(run, {
			status: "blocked",
			reason: childOutcome === "failed" ? "child_failed" : "child_cancelled",
			lastOutput: last,
			childMayHaveMutatedRepo: true,
		});
		retire(run);
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

	function retire(run: WorkspaceAgentRun): void {
		// Terminal lifecycle: kill the settled child, keep the record (the
		// runtime preserves the terminal state; no cancelled marking).
		void runtime.retire(run.agentId).catch(() => {
			// already dead — the record stays as settled
		});
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
			finish(run, {
				status: "partial",
				reason: "deadline",
				lastOutput: undefined, // resolved post-cancel for the record
				childMayHaveMutatedRepo: true,
			});
			// Semantic cancel — the real cancel, never retire: the child did
			// not settle into a trusted outcome.
			void runtime
				.cancel(run.agentId)
				.then(async () => {
					if (run.terminal && !run.terminal.lastOutput) {
						run.terminal.lastOutput = await lastOutput(run.agentId);
					}
				})
				.catch(() => {});
		}, remaining);
		run.deadlineTimer.unref?.();
	}

	// -------------------------------------------------------------- envelope

	function envelopeFilePath(agentId: string): string {
		return path.join(runtime.getResultsDir(), envelopeFileName(agentId));
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
		const snap = runtime.inspect(agentId)[0];
		if (snap?.lastError) return snap.lastError;
		try {
			const res = await runtime.result(agentId);
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
		return [
			path.join(moduleDirname(), "..", "task-workspace", "index.ts"),
			path.join(moduleDirname(), "reporting-bridge.ts"),
		];
	}

	// ----------------------------------------------------------------- tool

	pi.registerTool({
		name: "workspace_agent",
		label: "Workspace Agent",
		description:
			"Run a RepoOwner agent rooted in a managed task worktree. Dispatch-mode: workspace_agent(workspace, task, " +
			"timeout_ms?) blocks until a terminal outcome (done/partial/blocked) or needs_input; strict validation and " +
			"readiness happen before dispatch (fail closed), and there is no fallback after dispatch — abort detaches " +
			"and the run keeps going. Query-mode: workspace_agent(run_id) returns the current state or the terminal " +
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
			snap = await runtime.spawn({
				task,
				label: `owner-${base}`,
				cwd: realWorkspace,
				model: `${ctx.model.provider}/${ctx.model.id}`,
				thinking: ctx.thinkingLevel,
				additionalExtensions: profileEntries(),
				readinessEntries: PROFILE_READINESS,
				eventRoute: "workspace",
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const kind: "unsupported" | "error" = message.includes("readiness handshake") ? "unsupported" : "error";
			return fail(kind, workspace, message);
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
				cleanup();
				resolve(outcome);
			};
			run.waiters.push(w);
			const onAbort = () => w("detached");
			function cleanup() {
				signal?.removeEventListener("abort", onAbort);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});

		if (waitOutcome === "detached") {
			return ok({
				status: run.terminal ? run.terminal.status : "blocked",
				dispatched: true,
				workspace: realWorkspace,
				agentId: run.agentId,
				runId,
				state: run.state,
				deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
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
				deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
			};
		}
		return {
			...base,
			status: "blocked",
			state: run.state,
			deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
			reason: "run is still in progress (query-mode snapshot)",
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

/** Directory of this module (works under jiti and node). */
function moduleDirname(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return __dirname;
	}
}
