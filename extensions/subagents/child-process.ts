/**
 * ChildAgentProcess — one child pi process and everything that belongs to its
 * own lifecycle: the RPC connection, the readiness handshake, dispatch
 * preflight, user questions, timers, cancellation/retirement, and settlement.
 *
 * LocalSubagentRuntime owns the COLLECTION: the agent list, user-facing
 * operations across agents, event and result routing, persistence, and the
 * shutdown of every child. This object never reaches into that collection; it
 * reports facts and lifecycle events through ChildAgentHost and keeps its own
 * state private.
 *
 * Event flow (proven against pi 0.85.1):
 * - child `agent_start` -> authoritative run boundary: reset run-local state
 * - child settles  -> fetch state + final text + stats -> terminal result
 * - child exits before settling -> failed (never a stuck "running")
 * - child extension_ui_request (the `ask` tool) -> waiting_input; answered
 *   via extension_ui_response, which resumes the very same tool call. The
 *   pending question is cleared when the ask tool call ends, so an aborted
 *   or resolved dialog cannot desync the record. The structured canonical
 *   request travels through the request payload losslessly.
 * - cancel -> RPC abort, then SIGTERM (pi exits cleanly even while blocked in
 *   a UI dialog), then SIGKILL escalation
 *
 * Input delivery (steer / follow_up) always goes through `prompt` +
 * `streamingBehavior`, letting pi — not a controller-side copy of its state
 * machine — atomically decide between queueing and a fresh run.
 */
import * as fs from "node:fs";
import { RpcChildConnection, type ExitInfo, type SpawnFn } from "./rpc-child.ts";
import { parseReadinessPayload, type ReadinessPayload } from "./readiness.ts";
import { ASK_WIRE_TITLE } from "./bridge-ask.ts";
import { formatAskRequestFlat, parseAskRequest, type AskInput } from "../ask/contract.ts";
import type {
	AgentResult,
	AgentSnapshot,
	AgentState,
	SessionStats,
	SubagentModelEvent,
	ToolActivity,
	WaitOutcome,
} from "./types.ts";
import { summarizeToolActivity } from "./activity.ts";
import { normalizeLastText, publicAssistantText, type LastAssistantText } from "./last-text.ts";
import { summarizeText } from "./result-store.ts";

/** Live tool-activity bounds: status telemetry, never a log buffer. */
const ACTIVE_TOOLS_MAX = 8;
const RECENT_ACTIVITY_MAX = 4;

const ASK_TOOL = "ask";

/**
 * Bounded stderr excerpt surfaced in startup-failure messages. The
 * connection keeps the full 8000-char tail for diagnostics; the surfaced
 * reason carries only the last ~2000 chars so the model-facing error stays
 * readable while still showing the real cause (e.g. `Error: Model ... not
 * found` from a child that died before RPC).
 */
const STDERR_SURFACE_MAX = 2000;

/** An active tool entry keeps its RPC correlation id internally. */
type ActiveToolEntry = ToolActivity & { toolCallId: string };

/** RPC request ids stay unique across all children of one host process. */
let requestSeq = 0;

/** Everything this child needs to become a process; resolved by the runtime. */
export interface ChildAgentSpec {
	id: string;
	label: string;
	/** Canonical task (results, status views). */
	task: string;
	/** Prompt actually sent to this child (task, or a task-derived prompt). */
	initialPrompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	spawnFn?: SpawnFn;
	/**
	 * Readiness contract: entry id -> required tool names. Non-empty means the
	 * task prompt is withheld until the child reports its tool set and every
	 * listed entry is satisfied (fail closed).
	 */
	readinessEntries?: Record<string, string[]>;
	/** Lifecycle events of this child belong to the workspace layer. */
	eventRoute?: "workspace";
	/** Terminal idle-exit delay in ms; `<= 0` disables. */
	idleExitMs: number;
	/** Publication hook fired synchronously on prompt acceptance. */
	onAccepted?: (snapshot: AgentSnapshot) => void;
}

export interface ChildTimeouts {
	/** Max time to wait for the initial prompt to be accepted. */
	startMs: number;
	/** Max time to wait for a dispatch (steer/follow_up) preflight response. */
	dispatchMs: number;
	/** Max time to wait for the readiness handshake of profiled children. */
	readinessMs: number;
	/** Grace period between SIGTERM and SIGKILL. */
	killGraceMs: number;
}

/**
 * Facts of a settled child, shaped for persistence. The runtime owns the
 * results directory, the parent-session attribution and the optional run
 * history, so it — not the child — writes the final AgentResult.
 */
export interface ChildResultFacts {
	id: string;
	label: string;
	task: string;
	cwd: string;
	status: AgentResult["status"];
	finalText?: string;
	failureReason?: string;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	tokens?: AgentResult["tokens"];
	exitCode?: number | null;
	signal?: string | null;
	processKilledAt?: number;
	lastAssistantText?: LastAssistantText;
}

/** Facts of a live child, shaped for the spawn-time "running" marker. */
export interface ChildMarkerFacts {
	id: string;
	label: string;
	task: string;
	cwd: string;
	startedAt: number;
	pid?: number;
	lastAssistantText?: LastAssistantText;
}

/** The collection-facing port of one child. */
export interface ChildAgentHost {
	/** Route one lifecycle event (workspace registry vs generic waiters/listeners). */
	emit(ev: SubagentModelEvent, opts?: { background?: boolean }): void;
	/** Advisory: this child's observable record changed. */
	changed(): void;
	/** Persist the terminal result (or a re-persisted one). */
	persistResult(facts: ChildResultFacts): void;
	/** Write/refresh the spawn-time running marker. */
	persistMarker(facts: ChildMarkerFacts): void;
	/** This child reported its cumulative cost. */
	costReported(agentId: string, cost: number): void;
}

export class ChildAgentProcess {
	readonly id: string;
	readonly eventRoute?: "workspace";

	private readonly spec: ChildAgentSpec;
	private readonly timeouts: ChildTimeouts;
	private readonly host: ChildAgentHost;
	private readonly conn: RpcChildConnection;
	private readonly startedAt: number;
	private readonly idleExitMs: number;
	private readonly readinessExpected: Map<string, string[]>;

	private state: AgentState = "starting";
	private lastActivityAt: number;
	private endedAt?: number;
	private sessionFile?: string;
	/** Pi-reported path held until a real session file exists on disk. */
	private pendingSessionFile?: string;
	private sessionId?: string;
	private finalText?: string;
	/** Last PUBLIC assistant text (bounded projection from completed message_end events). */
	private lastAssistantText?: LastAssistantText;
	/** Failure of the current run; cleared by `agent_start` and on success. */
	private runError?: string;
	/** Process-level failure (spawn, watchdog, unexpected exit). */
	private lastError?: string;
	/** Latest live session stats (tokens, cost, context fill); replaced wholesale. */
	private stats?: SessionStats;
	private exitCode?: number | null;
	private signal?: string | null;
	/** Kill timestamp when the process died after the record had settled. */
	private processKilledAt?: number;
	private pendingQuestion?: { requestId: string; request: AskInput; question: string; askedAt: number };
	/** Tools currently executing, keyed by toolCallId (pi may run tools in parallel). */
	private readonly activeTools = new Map<string, ActiveToolEntry>();
	/** Most recently finished tools, oldest first, hard-capped (RECENT_ACTIVITY_MAX). */
	private recentActivity: ToolActivity[] = [];
	private cancelRequested = false;
	/**
	 * New work was dispatched (prompt + streamingBehavior) while the child was
	 * in a terminal state. Until the child's `agent_start` proves the new run
	 * actually began, outcome()/facts must not present the previous terminal
	 * result as the outcome of the pending work.
	 */
	private pendingDispatch = false;
	/** True between child `agent_start` and the matching `agent_settled`. */
	private runActive = false;
	/** Terminal retire requested: kill the process, keep the terminal record. */
	private retireRequested = false;
	/** Armed idle-exit timer; cleared by any dispatch, new run, or question. */
	private idleTimer?: NodeJS.Timeout;
	private readinessDone = false;
	private acceptTimer?: NodeJS.Timeout;
	private readinessTimer?: NodeJS.Timeout;
	private onAccepted?: (snapshot: AgentSnapshot) => void;
	/** Pending start() completion (the caller's only spawn outcome). */
	private completion?: { resolve: (snapshot: AgentSnapshot) => void; reject: (err: Error) => void };
	private abortSignal?: AbortSignal;
	private readonly onSpawnAbort = () => {
		// Pre-dispatch abort: until the initial task prompt is RPC-accepted, an
		// abort kills the child and fails the spawn. After acceptance this
		// handler is inert (spawnSettled guard) — ownership of the signal moves
		// to the caller (abort = detach).
		if (!this.spawnSettled) this.failSpawn("aborted before dispatch", "SIGKILL");
	};
	/** True once the initial prompt was accepted or the spawn failed. */
	private spawnSettled = false;
	private settleFetchDone = false;
	/** Correlated one-shot request resolvers (dispatch preflights, proxy acks). */
	private readonly waiters = new Map<string, (ev: Record<string, unknown>) => void>();

	constructor(spec: ChildAgentSpec, timeouts: ChildTimeouts, host: ChildAgentHost) {
		this.spec = spec;
		this.timeouts = timeouts;
		this.host = host;
		this.id = spec.id;
		this.eventRoute = spec.eventRoute;
		this.idleExitMs = spec.idleExitMs;
		this.readinessExpected = new Map(Object.entries(spec.readinessEntries ?? {}));
		this.onAccepted = spec.onAccepted;
		this.startedAt = Date.now();
		this.lastActivityAt = this.startedAt;

		this.conn = new RpcChildConnection({
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			spawnFn: spec.spawnFn,
		});
		this.conn.onLine = (line) => this.handleChildLine(line);
		this.conn.onStderr = () => {
			this.lastActivityAt = Date.now();
		};
		this.conn.onError = (err) => {
			this.lastError = `spawn error: ${err.message}`;
			this.finishWithFailure(`spawn error: ${err.message}`);
		};
		this.conn.onExit = (info) => this.handleChildExit(info);
	}

	// -------------------------------------------------------------- read model

	get label(): string {
		return this.spec.label;
	}

	get task(): string {
		return this.spec.task;
	}

	get cwd(): string {
		return this.spec.cwd;
	}

	get model(): string | undefined {
		return this.spec.model;
	}

	get thinking(): string | undefined {
		return this.spec.thinking;
	}

	/** Idle-exit delay this child was created with (fresh spawns inherit it). */
	get idleExit(): number {
		return this.idleExitMs;
	}

	get currentState(): AgentState {
		return this.state;
	}

	get alive(): boolean {
		return !this.conn.exit;
	}

	/** Terminal retire was requested (the process is being or was stopped). */
	get retiring(): boolean {
		return this.retireRequested;
	}

	/** A terminal state was reached (regardless of a pending re-dispatch). */
	get settled(): boolean {
		return isTerminal(this.state);
	}

	/** A workspace child accepts queue-only steering while its run is live. */
	canAcceptQueuedSteer(): boolean {
		return this.runActive && !isTerminal(this.state) && !this.cancelRequested && !this.retireRequested;
	}

	/** The current meaningful outcome, or undefined while there is nothing to report. */
	outcome(): WaitOutcome | undefined {
		if (this.pendingDispatch) return undefined;
		if (this.state === "waiting_input") {
			const pending = this.pendingQuestion;
			return {
				status: "needs_input",
				question: pending?.question ?? "(unknown question)",
				...(pending ? { request: pending.request } : {}),
			};
		}
		if (this.state === "completed") return { status: "completed", summary: summarizeText(this.finalText) };
		if (this.state === "failed") return { status: "failed", reason: this.runError ?? this.lastError ?? "agent failed" };
		if (this.state === "cancelled") return { status: "cancelled" };
		return undefined;
	}

	/** True when a final result may be handed out (settled and not re-dispatched). */
	hasFinalResult(): boolean {
		return isTerminal(this.state) && !this.pendingDispatch;
	}

	/** Settled facts for persistence, or undefined while the child is not terminal. */
	terminalFacts(): ChildResultFacts | undefined {
		if (this.state !== "completed" && this.state !== "failed" && this.state !== "cancelled") return undefined;
		const status = this.state;
		return {
			id: this.id,
			label: this.spec.label,
			task: this.spec.task,
			cwd: this.spec.cwd,
			status,
			finalText: this.finalText,
			failureReason: status === "failed" ? this.runError ?? this.lastError : undefined,
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			model: this.spec.model,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			tokens: statsToResultTokens(this.stats),
			exitCode: this.exitCode,
			signal: this.signal,
			...(this.processKilledAt !== undefined ? { processKilledAt: this.processKilledAt } : {}),
			...(this.lastAssistantText !== undefined ? { lastAssistantText: { ...this.lastAssistantText } } : {}),
		};
	}

	markerFacts(): ChildMarkerFacts {
		return {
			id: this.id,
			label: this.spec.label,
			task: this.spec.task,
			cwd: this.spec.cwd,
			startedAt: this.startedAt,
			...(this.conn.pid !== undefined ? { pid: this.conn.pid } : {}),
			...(this.lastAssistantText !== undefined ? { lastAssistantText: { ...this.lastAssistantText } } : {}),
		};
	}

	snapshot(): AgentSnapshot {
		this.promoteSessionFile();
		return {
			id: this.id,
			label: this.spec.label,
			state: this.state,
			task: this.spec.task,
			cwd: this.spec.cwd,
			model: this.spec.model,
			thinking: this.spec.thinking,
			alive: !this.conn.exit,
			pid: this.conn.pid,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			lastActivityAt: this.lastActivityAt,
			elapsedMs: (this.endedAt ?? Date.now()) - this.startedAt,
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			pendingQuestion: this.pendingQuestion?.question,
			lastError: this.lastError ?? this.runError,
			stats: this.stats,
			exitCode: this.exitCode,
			signal: this.signal,
			activeTool: this.conn.exit ? undefined : newestActiveTool(this.activeTools),
			recentActivity: this.recentActivity.map((entry) => ({ ...entry })),
			...(this.lastAssistantText !== undefined ? { lastAssistantText: { ...this.lastAssistantText } } : {}),
		};
	}

	// ------------------------------------------------------------------ start

	/**
	 * Dispatch the initial task. Resolves once the child RPC-accepted the
	 * prompt; rejects on any pre-dispatch failure (readiness, accept timeout,
	 * early exit) with the child killed and the task never sent.
	 */
	start(signal?: AbortSignal): Promise<AgentSnapshot> {
		const promise = new Promise<AgentSnapshot>((resolve, reject) => {
			this.completion = { resolve, reject };
		});
		if (this.conn.exit || this.spawnSettled) {
			// The process already died (or the spawn already failed) before the
			// caller started it: settle immediately instead of hanging.
			this.settleSpawn(false);
			return promise;
		}
		this.abortSignal = signal;
		if (signal?.aborted) {
			// The caller's signal was already aborted: fail closed like any
			// pre-dispatch abort instead of waiting for an event that fired.
			this.failSpawn("aborted before dispatch", "SIGKILL");
			return promise;
		}
		signal?.addEventListener("abort", this.onSpawnAbort, { once: true });
		if (this.readinessExpected.size > 0) {
			// Fail-closed dispatch: the task prompt is withheld until every
			// profiled extension confirmed initialization over the readiness
			// handshake, so a broken/missing extension can never reach the model.
			this.readinessTimer = setTimeout(() => {
				if (this.readinessDone || this.spawnSettled) return;
				this.failSpawn(`readiness handshake did not complete in time${this.stderrExcerpt()}`, "SIGKILL");
			}, this.timeouts.readinessMs);
			this.readinessTimer.unref?.();
		} else {
			this.sendInitialPrompt();
		}
		return promise;
	}

	/** Arm the acceptance timer and send the initial task prompt. */
	private sendInitialPrompt(): void {
		if (this.spawnSettled || this.conn.exit) return;
		this.acceptTimer = setTimeout(() => {
			if (!this.spawnSettled) {
				this.lastError = `child did not accept the initial prompt in time${this.stderrExcerpt()}`;
				this.finishWithFailure(this.lastError);
				this.conn.kill("SIGKILL");
			}
		}, this.timeouts.startMs);
		this.acceptTimer.unref?.();
		this.conn.send({ id: "spawn-prompt", type: "prompt", message: this.spec.initialPrompt });
	}

	private clearSpawnTimers(): void {
		if (this.acceptTimer) clearTimeout(this.acceptTimer);
		if (this.readinessTimer) clearTimeout(this.readinessTimer);
		this.acceptTimer = undefined;
		this.readinessTimer = undefined;
	}

	/**
	 * Settle the start() promise (idempotent): clear spawn timers, drop the
	 * pre-dispatch abort listener, and resolve/reject the one caller outcome.
	 */
	private settleSpawn(ok: boolean): void {
		this.spawnSettled = true;
		this.readinessDone = true;
		this.clearSpawnTimers();
		if (this.abortSignal) {
			this.abortSignal.removeEventListener("abort", this.onSpawnAbort);
			this.abortSignal = undefined;
		}
		const completion = this.completion;
		this.completion = undefined;
		if (!completion) return;
		if (ok) completion.resolve(this.snapshot());
		else completion.reject(new Error(this.lastError ?? "child failed to start"));
	}

	/**
	 * Fail a spawn before dispatch: settle the caller outcome with failure,
	 * surface the terminal failure, and kill the child. The task prompt has
	 * not been sent.
	 */
	private failSpawn(reason: string, signal?: string): void {
		if (this.spawnSettled) return;
		this.readinessDone = true;
		this.lastError = reason;
		this.clearSpawnTimers();
		this.settleSpawn(false);
		this.finishWithFailure(reason);
		if (signal && !this.conn.exit) this.conn.kill(signal);
	}

	// ------------------------------------------------------- child RPC plumbing

	private handleChildLine(line: string): void {
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line);
		} catch {
			return; // not protocol JSON — ignore
		}
		this.lastActivityAt = Date.now();
		const type = ev.type as string;

		if (type === "extension_ui_request") {
			this.handleUiRequest(ev);
			return;
		}
		if (type === "tool_execution_start") {
			this.trackToolStart(ev);
			return;
		}
		if (type === "tool_execution_end") {
			this.trackToolEnd(ev);
			// The ask tool call ended: the dialog was resolved one way or
			// another (answer, user dismiss, or an abort that never sends an
			// extension_ui_response). Sync the child so a phantom pending
			// question cannot survive. Workspace-routed children also learn
			// about the resolution (input_resolved), so the run registry stops
			// reporting a question that is no longer pending.
			if (ev.toolName === ASK_TOOL && this.pendingQuestion) {
				this.pendingQuestion = undefined;
				if (this.state === "waiting_input") {
					this.state = "running";
					this.host.changed();
				}
				if (this.eventRoute === "workspace") {
					this.host.emit({ kind: "input_resolved", agentId: this.id, label: this.spec.label });
				}
			}
			return;
		}

		if (type === "agent_start") {
			// Authoritative run boundary: reset run-local state. A queued
			// follow-up starting here also proves the child is working again —
			// any armed idle-exit timer is stale.
			this.clearIdleExit();
			this.runActive = true;
			this.runError = undefined;
			this.finalText = undefined;
			this.endedAt = undefined;
			this.pendingQuestion = undefined;
			this.pendingDispatch = false;
			this.activeTools.clear();
			this.recentActivity = [];
			if (!this.cancelRequested && this.state !== "starting") {
				this.state = "running";
			}
			this.host.changed();
			return;
		}

		if (type === "agent_settled") {
			this.runActive = false;
			this.pendingQuestion = undefined;
			if (this.cancelRequested) return; // exit path will mark cancelled
			// Collect state, final text, and stats. Responses correlate by
			// command, so all three can go out at once.
			this.settleFetchDone = false;
			this.conn.send({ id: "ctl-state", type: "get_state" });
			this.getStats();
			this.conn.send({ id: "ctl-last-text", type: "get_last_assistant_text" });
			return;
		}

		if (type === "response") {
			const waiter = this.waiters.get(ev.id as string);
			if (waiter) {
				this.waiters.delete(ev.id as string);
				waiter(ev);
				return;
			}
			const cmd = ev.command as string;
			if (cmd === "prompt" && ev.id === "spawn-prompt") {
				if (!this.spawnSettled) {
					this.spawnSettled = true;
					this.state = isTerminal(this.state) ? this.state : this.pendingQuestion ? "waiting_input" : "running";
					// Session identity is fetched EARLY (single RPC request, no
					// polling) so the live operator view can show the session id
					// while the child runs — not only after settlement.
					if (ev.success === true) {
						this.onAccepted?.(this.snapshot());
						this.conn.send({ id: "ctl-state-early", type: "get_state" });
					}
					this.onAccepted = undefined;
					this.settleSpawn(ev.success === true);
					this.host.changed();
					if (ev.success !== true) {
						this.lastError = `initial prompt rejected: ${String(ev.error ?? "unknown")}`;
						this.finishWithFailure(this.lastError);
					}
				}
				return;
			}
			if (cmd === "get_state" && ev.success === true) {
				const data = ev.data as { sessionFile?: string; sessionId?: string } | undefined;
				this.sessionId = data?.sessionId ?? this.sessionId;
				// Pi reports the path before it creates the file. Keep that early
				// identity private until a bounded existence check succeeds; terminal
				// get_state retains its existing authoritative behavior.
				if (ev.id === "ctl-state-early") {
					if (typeof data?.sessionFile === "string" && data.sessionFile) {
						this.pendingSessionFile = data.sessionFile;
						this.promoteSessionFile();
					}
				} else {
					this.sessionFile = data?.sessionFile ?? this.sessionFile;
					this.pendingSessionFile = undefined;
				}
				return;
			}
			if (cmd === "get_last_assistant_text" && ev.success === true) {
				this.finalText = (ev.data as { text?: string } | undefined)?.text ?? "";
				this.completeSettle();
				return;
			}
			if (cmd === "get_session_stats" && ev.success === true) {
				const data = ev.data as SessionStats | undefined;
				if (data?.tokens) {
					this.stats = {
						tokens: {
							input: data.tokens.input ?? 0,
							output: data.tokens.output ?? 0,
							total: data.tokens.total ?? 0,
							...(typeof data.tokens.cacheRead === "number" ? { cacheRead: data.tokens.cacheRead } : {}),
							...(typeof data.tokens.cacheWrite === "number" ? { cacheWrite: data.tokens.cacheWrite } : {}),
						},
						...(typeof data.cost === "number" ? { cost: data.cost } : {}),
						...(data.contextUsage ? { contextUsage: data.contextUsage } : {}),
					};
					if (typeof data.cost === "number") this.host.costReported(this.id, data.cost);
				}
				return;
			}
			return;
		}

		if (type === "message_end") {
			const msg = ev.message as
				| { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }
				| undefined;
			if (msg?.role === "assistant") {
				// Persistence can lag this event. snapshot() retries the same check.
				this.promoteSessionFile();
				if (msg.stopReason === "error" && msg.errorMessage) {
					this.runError = msg.errorMessage;
				} else {
					// A successful assistant response supersedes any transient
					// provider error from an earlier retry attempt.
					this.runError = undefined;
				}
				// Live stats refresh: every completed assistant message moves the
				// cumulative token/cost/context numbers. Fire-and-forget — the
				// response handler is command-keyed and replaces the stats wholesale.
				this.getStats();
				this.acceptLastAssistantText(msg);
			}
			return;
		}

		if (type === "auto_retry_end") {
			if (ev.success === false && typeof ev.finalError === "string") {
				this.runError = ev.finalError;
			} else if (ev.success === true) {
				this.runError = undefined;
			}
		}
	}

	/**
	 * Child UI dialogs. With the minimal child environment the dialog sources
	 * are the base bridge's ask tool (`input`, title "ask") and the readiness
	 * handshake of profiled children (fire-and-forget `notify` carrying the
	 * readiness payload, fired from session_start handlers — blocking dialogs
	 * would deadlock: the child's stdin reader only attaches after
	 * rebindSession completes). Fire-and-forget requests other than readiness
	 * notifies are ignored.
	 */
	private handleUiRequest(ev: Record<string, unknown>): void {
		const method = ev.method as string;
		const id = ev.id as string;
		if (!id) return;
		if (method === "notify") {
			const payload = parseReadinessPayload(ev.message as string | undefined);
			if (payload) this.confirmReadiness(payload);
			return; // generic notifies are not dialogs
		}
		if (method !== "input") return; // select/confirm/editor are not produced by the bridge
		const title = ev.title as string;
		if (title !== ASK_WIRE_TITLE) return;
		// The payload is the child's structured canonical ask request; it is
		// never flattened — Main receives the original ids, options,
		// descriptions, previews, multi, and recommended flags.
		const request = parseAskRequest(ev.placeholder as string | undefined);
		if (!request) {
			// Unparseable payload: not produced by the current bridge. Fail
			// closed — cancel the dialog so the child tool gets "no answer"
			// instead of dead-waiting forever.
			this.conn.send({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		if (this.pendingQuestion) {
			// A previous question is still open: dismiss the duplicate so the
			// child tool gets "no answer" instead of dead-waiting forever.
			this.conn.send({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		this.pendingQuestion = {
			requestId: id,
			request,
			question: formatAskRequestFlat(request),
			askedAt: Date.now(),
		};
		this.state = "waiting_input";
		// Never idle-exit a child that is waiting for user input (F003 guard).
		this.clearIdleExit();
		this.host.emit({
			kind: "needs_input",
			agentId: this.id,
			label: this.spec.label,
			question: this.pendingQuestion.question,
			request,
		});
		this.host.changed();
	}

	/**
	 * Readiness report (profiled children only): validate the child's observed
	 * tool set against THIS spawn's readiness contract. Any entry with missing
	 * required tools fails the spawn with the child killed and the task prompt
	 * never sent (fail closed). All entries satisfied → the task prompt is
	 * sent (the dispatch point follows its acceptance).
	 */
	private confirmReadiness(payload: ReadinessPayload): void {
		if (this.readinessDone || this.spawnSettled) return;
		if (this.readinessExpected.size === 0) return; // not a profiled spawn; ignore
		const problems: string[] = [];
		for (const [entry, required] of this.readinessExpected) {
			const missing = required.filter((t) => !payload.tools.includes(t));
			if (missing.length > 0) problems.push(`entry "${entry}" is missing required tools: ${missing.join(", ")}`);
		}
		if (problems.length > 0) {
			this.failSpawn(`readiness handshake failed: ${problems.join("; ")}`, "SIGKILL");
			return;
		}
		this.readinessDone = true;
		if (this.readinessTimer) clearTimeout(this.readinessTimer);
		this.readinessTimer = undefined;
		this.sendInitialPrompt();
	}

	private handleChildExit(info: ExitInfo): void {
		if (isTerminal(this.state)) {
			// A kill landed after the record had already gone terminal.
			// First: a child that died before its spawn settled (the accept
			// timer or a spawn error already failed the record) must still
			// reject its pending spawn caller — that rejection is the caller's
			// only outcome, so terminal preservation must not swallow it.
			if (!this.spawnSettled) {
				this.settleSpawn(false);
				return;
			}
			// Otherwise: a cancel/shutdown kill landed after the record had
			// already settled (e.g. cancelAll SIGTERMs a completed child).
			// Preserve the settled terminal state and result exactly — state,
			// endedAt, exitCode and signal stay as they were; only the kill
			// timestamp is recorded. Mirrors retire semantics: never turn a
			// settled outcome into cancelled, never emit a second terminal event.
			this.processKilledAt = Date.now();
			this.persistResult();
			// Process exit of an already-terminal record: no set change, the
			// signature dedup suppresses the frame.
			this.host.changed();
			return;
		}
		this.exitCode = info.code;
		this.signal = info.signal;
		this.endedAt = Date.now();
		this.pendingDispatch = false;
		// A dead child cannot be answered; drop any pending question so
		// snapshots of terminal agents do not show a stale dialog.
		this.pendingQuestion = undefined;
		if (!this.spawnSettled) {
			this.lastError =
				this.lastError ??
				`child exited before accepting the prompt (code ${info.code}, signal ${info.signal})${this.stderrExcerpt()}`;
			this.settleSpawn(false);
			this.finishWithFailure(this.lastError);
			return;
		}
		if (this.cancelRequested) {
			this.markTerminal("cancelled");
			this.host.emit({ kind: "cancelled", agentId: this.id, label: this.spec.label }, { background: false });
			return;
		}
		if (this.retireRequested) {
			// Terminal retire: the process is killed after a settled terminal
			// outcome. The record keeps its terminal state and result — retire
			// never turns a completed/failed record into cancelled. The
			// notification is normally a no-op for the running set (already
			// terminal; signature dedup), but a retire of a still-running
			// record is only visible through the process death.
			this.host.changed();
			return;
		}
		if (this.runActive) {
			// A run was in progress and never settled.
			this.finishWithFailure(`child exited unexpectedly before completing (code ${info.code}, signal ${info.signal})`);
			return;
		}
		// All runs settled; a self-exit with a non-zero code or a kill signal
		// is still a process failure worth surfacing.
		if ((info.code ?? 0) !== 0 || info.signal) {
			this.lastError = `child exited with code ${info.code} / signal ${info.signal} after completing`;
			this.finishWithFailure(this.lastError);
			return;
		}
		// Clean self-exit after the last run settled: the record may still be
		// non-terminal when the exit wins the race with the settle fetch (e.g.
		// `agent_settled` then a clean exit before `get_last_assistant_text`
		// answers). The state never terminalizes in that case, so the process
		// death is the only thing that removes it from the running set —
		// publish it. Signature dedup makes the call free when nothing changed.
		this.host.changed();
	}

	// ------------------------------------------------------ terminal settlement

	// Collect settle-time fetches, then decide the run outcome.
	private completeSettle(): void {
		if (this.settleFetchDone) return;
		this.settleFetchDone = true;
		if (this.cancelRequested) return;
		if (this.runError) {
			this.finishWithFailure(this.runError);
			return;
		}
		this.state = "completed";
		this.endedAt = Date.now();
		this.persistResult();
		this.host.emit({
			kind: "completed",
			agentId: this.id,
			label: this.spec.label,
			summary: summarizeText(this.finalText),
		});
		this.host.changed();
		// F003 idle-exit: the settled child's process would otherwise live
		// forever. Retirement uses retire semantics — record and event stay.
		this.armIdleExit();
	}

	private finishWithFailure(reason: string): void {
		if (isTerminal(this.state)) return;
		this.state = "failed";
		this.runError = reason;
		this.endedAt = Date.now();
		this.persistResult();
		this.host.emit({ kind: "failed", agentId: this.id, label: this.spec.label, reason });
		this.host.changed();
		// A failed-but-alive child (e.g. error stopReason at settle) is reaped
		// by the same idle-exit path as a completed one.
		this.armIdleExit();
	}

	private markTerminal(state: "cancelled"): void {
		if (isTerminal(this.state)) return;
		this.state = state;
		this.endedAt = this.endedAt ?? Date.now();
		this.persistResult();
		this.host.changed();
	}

	private persistResult(): void {
		const facts = this.terminalFacts();
		if (facts) this.host.persistResult(facts);
	}

	/**
	 * F003 idle-exit: a settled child whose process is still alive will never
	 * exit on its own — schedule its termination after idleExitMs. Retirement
	 * reuses retire() semantics: the terminal record, its state, endedAt and
	 * event are preserved; only processKilledAt is added. Disarmed by any
	 * dispatch (steer/follow_up reuse completed children — a queued follow-up
	 * must not be killed), by a new run (agent_start), and by a pending
	 * question (never kill a child waiting for user input).
	 */
	private armIdleExit(): void {
		if (this.idleExitMs <= 0) return;
		if (!isTerminal(this.state)) return;
		if (this.pendingQuestion || this.retireRequested || this.conn.exit) return;
		this.clearIdleExit();
		const timer = setTimeout(() => {
			this.idleTimer = undefined;
			// Re-validate at fire time: a dispatch may have raced the timer.
			if (!isTerminal(this.state)) return;
			if (this.conn.exit || this.pendingQuestion || this.retireRequested) return;
			if (this.pendingDispatch) {
				// A dispatch preflight is in flight — the child may be about to
				// run again. Re-arm and let the dispatch outcome decide.
				this.armIdleExit();
				return;
			}
			this.retire().catch(() => {
				// idle-exit must never surface; a failed kill is retried by the
				// next cancel/shutdown (and the process leaks no worse than before)
			});
		}, this.idleExitMs);
		// Unref'd: a pending idle-exit must never keep the host (or the test
		// suite) alive. The collection additionally clears every timer on shutdown.
		timer.unref?.();
		this.idleTimer = timer;
	}

	private clearIdleExit(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	// ------------------------------------------------------------- operations

	/**
	 * Deliver new input via `prompt` + `streamingBehavior`: pi atomically
	 * picks queueing vs a fresh run from the session's real state — no stale
	 * local copy. `queueOnly` uses the steer RPC so an idle race cannot start a
	 * new run (workspace children).
	 *
	 * When the child sits in a terminal state, the dispatch marks the old
	 * result stale (`pendingDispatch`) until its `agent_start` proves the new
	 * run began; outcome()/terminalFacts() must not hand back the previous
	 * completion as the outcome of the pending work. A rejected preflight
	 * clears the mark and surfaces the error to the caller.
	 */
	async dispatch(behavior: "steer" | "followUp", message: string, queueOnly = false): Promise<void> {
		if (this.conn.exit) {
			throw new Error(`cannot ${behavior === "steer" ? "steer" : "follow_up"}: agent ${this.id} process is not running (state: ${this.state})`);
		}
		// Live input reuses the child: any armed idle-exit is stale now. If the
		// dispatch fails below, the timer is re-armed (the child is back to an
		// idle terminal state with a live process).
		this.clearIdleExit();
		const overTerminal = isTerminal(this.state);
		if (overTerminal) this.pendingDispatch = true;
		try {
			const resp = await this.request(
				`dispatch-${++requestSeq}`,
				queueOnly
					? { type: "steer", message }
					: { type: "prompt", message, streamingBehavior: behavior },
				`pi did not acknowledge the ${behavior} dispatch in time`,
			);
			if (resp.success !== true) {
				throw new Error(`pi rejected the ${behavior}: ${String(resp.error ?? "unknown")}`);
			}
		} catch (err) {
			if (overTerminal) this.pendingDispatch = false;
			if (overTerminal && !this.conn.exit) this.armIdleExit();
			throw err;
		}
	}

	/**
	 * Push a bridge command through the RPC prompt path and report whether the
	 * child acknowledged it. An unacked child keeps running (children self-heal
	 * on their next model request), so a timeout is `false`, not an error.
	 */
	async pushCommand(message: string): Promise<boolean> {
		if (this.conn.exit) return false;
		try {
			const resp = await this.request(
				`proxy-${++requestSeq}`,
				{ type: "prompt", message },
				"proxy push not acknowledged in time",
			);
			return resp.success === true;
		} catch {
			return false;
		}
	}

	/** Send one correlated request and resolve with its RPC response. */
	private request(
		id: string,
		command: Record<string, unknown>,
		timeoutReason: string,
	): Promise<Record<string, unknown>> {
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new Error(timeoutReason));
			}, this.timeouts.dispatchMs);
			timer.unref?.();
			this.waiters.set(id, resolve);
			this.conn.send({ id, ...command });
		});
	}

	/** Answer the pending ask question (resumes the same child tool call). */
	respond(answer: string): void {
		if (this.conn.exit) {
			throw new Error(`agent ${this.id} process has exited (state: ${this.state})`);
		}
		const q = this.pendingQuestion;
		if (!q) throw new Error(`agent ${this.id} has no pending question`);
		this.pendingQuestion = undefined;
		this.state = "running";
		if (this.eventRoute === "workspace") {
			this.host.emit({ kind: "input_resolved", agentId: this.id, label: this.spec.label });
		}
		this.host.changed();
		this.conn.send({ type: "extension_ui_response", id: q.requestId, value: answer });
	}

	async cancel(): Promise<void> {
		if (this.conn.exit) {
			if (!isTerminal(this.state)) this.markTerminal("cancelled");
			return;
		}
		this.cancelRequested = true;
		this.clearIdleExit(); // the kill below makes any idle timer moot
		// pi abort: ends the current run with stopReason "aborted"; the session
		// stays valid. Harmless when the child is idle or blocked in a dialog.
		// SIGTERM follows immediately: pi exits cleanly (exit code 143) even
		// while blocked inside an extension UI dialog.
		this.conn.send({ type: "abort" });
		this.conn.kill("SIGTERM");
		const escalated = await Promise.race([
			this.conn.waitForExit().then(() => false),
			new Promise<true>((resolve) => setTimeout(() => resolve(true), this.timeouts.killGraceMs)),
		]);
		if (escalated && !this.conn.exit) {
			this.conn.kill("SIGKILL");
			await this.conn.waitForExit();
		}
		this.host.changed();
	}

	/**
	 * Terminal termination (not a model-facing op): kill the child while
	 * PRESERVING its terminal record — state stays whatever settlement made it
	 * (e.g. completed) and the persisted result is untouched. Unlike cancel(),
	 * no cancelled status is written and no cancelled event is emitted.
	 */
	async retire(): Promise<void> {
		if (this.conn.exit) return;
		this.retireRequested = true;
		// Abort is harmless for a settled child and covers the rare case of a
		// ladder follow-up having just started a new run.
		this.conn.send({ type: "abort" });
		this.conn.kill("SIGTERM");
		const escalated = await Promise.race([
			this.conn.waitForExit().then(() => false),
			new Promise<true>((resolve) => setTimeout(() => resolve(true), this.timeouts.killGraceMs)),
		]);
		if (escalated && !this.conn.exit) {
			this.conn.kill("SIGKILL");
			await this.conn.waitForExit();
		}
		// A retire of an already-terminal record changes no running set; the
		// signature dedup suppresses the frame. Recorded as a mutation point
		// because retire is the only process exit that preserves terminal state.
		this.host.changed();
	}

	// ---------------------------------------------------------------- internals

	/**
	 * Authoritative child activity, distilled for the live operator view.
	 * tool_execution_start (name + conservatively summarized args) opens a
	 * bounded active window keyed by toolCallId; tool_execution_end closes it
	 * into the hard-capped recent list. Unmatched or id-less ends are ignored
	 * rather than guessed.
	 */
	private trackToolStart(ev: Record<string, unknown>): void {
		const name = typeof ev.toolName === "string" && ev.toolName ? ev.toolName : "tool";
		const toolCallId = typeof ev.toolCallId === "string" && ev.toolCallId
			? ev.toolCallId
			: `unmatched-${Date.now()}-${this.activeTools.size}`;
		if (this.activeTools.size >= ACTIVE_TOOLS_MAX) {
			const oldest = this.activeTools.keys().next().value;
			if (oldest !== undefined) this.activeTools.delete(oldest);
		}
		this.activeTools.set(toolCallId, {
			toolCallId,
			name,
			// The child's cwd (managed worktree for workspace runs) lets the
			// summary stay workspace-relative instead of burning the cap on the
			// absolute worktree prefix.
			summary: summarizeToolActivity(name, ev.args, this.spec.cwd),
			startedAt: Date.now(),
		});
	}

	private trackToolEnd(ev: Record<string, unknown>): void {
		const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
		if (toolCallId === undefined) return;
		const ended = this.activeTools.get(toolCallId);
		if (!ended) return;
		this.activeTools.delete(toolCallId);
		this.recentActivity.push({
			name: ended.name,
			summary: ended.summary,
			startedAt: ended.startedAt,
			endedAt: Date.now(),
		});
		if (this.recentActivity.length > RECENT_ACTIVITY_MAX) {
			this.recentActivity.splice(0, this.recentActivity.length - RECENT_ACTIVITY_MAX);
		}
		// Tool-reported nested LLM usage does not produce an assistant
		// message_end; refresh the live stats here as well (fire-and-forget).
		this.getStats();
	}

	private getStats(): void {
		this.conn.send({ id: "ctl-stats", type: "get_session_stats" });
	}

	private stderrExcerpt(): string {
		const tail = this.conn.stderr.trim();
		if (!tail) return "";
		const excerpt = tail.length > STDERR_SURFACE_MAX ? `…${tail.slice(-STDERR_SURFACE_MAX)}` : tail;
		return `\nchild stderr (tail):\n${excerpt}`;
	}

	/**
	 * Automatic bounded projection of the child's last PUBLIC assistant text
	 * (plain and workspace children alike): completed `message_end` text
	 * blocks only. Thinking, tool calls, tool results, error/aborted/deferred
	 * messages and empty text never replace an accepted fragment; the runtime
	 * assigns updatedAt. Acceptance is bounded to non-terminal records, so a
	 * late event after settlement cannot mutate a terminal record. Persistence
	 * rides the existing result path: the running marker is rewritten on every
	 * accepted change and the terminal write keeps the fragment.
	 */
	private acceptLastAssistantText(msg: { stopReason?: string; content?: unknown }): void {
		if (isTerminal(this.state)) return; // never mutate a terminal record late
		const raw = publicAssistantText(msg);
		if (raw === undefined) return;
		const text = normalizeLastText(raw);
		if (text === undefined) return;
		this.lastAssistantText = { text, updatedAt: Date.now() };
		this.host.persistMarker(this.markerFacts());
	}

	private promoteSessionFile(): void {
		const candidate = this.pendingSessionFile;
		if (!candidate) return;
		try {
			if (!fs.statSync(candidate).isFile()) return;
		} catch {
			return; // Pi has not persisted the file yet (or it is inaccessible).
		}
		this.sessionFile = candidate;
		this.pendingSessionFile = undefined;
	}
}

/**
 * How one child pi process is launched: the resolved parent invocation plus
 * the child-only extension stack and environment.
 */
export interface ChildLaunchConfig {
	/** Resolved parent pi invocation (command + base args). */
	piInvocation: { command: string; args: string[] };
	/** Bridge extension (ask/proxy plumbing) loaded into every child. */
	bridgePath: string;
	/** Base web-search extension loaded into every child. */
	webSearchPath: string;
	/** Extension entries of the child model's provider (already resolved). */
	providerEntries: string[];
	/** Extra entries loaded into THIS child only, order preserved. */
	additionalExtensions?: string[];
	label: string;
	model?: string;
	thinking?: string;
	resultsDir: string;
	subagentId: string;
}

/**
 * Build the argv and environment of one child pi process. Children run with
 * `--no-extensions -e <bridge>` so they get a minimal, controlled environment
 * (no parent extension stack; a generic child cannot spawn subagents at all —
 * only a workspace worker carries the subagents index, and its nested spawns
 * are plain helpers only: workspace ownership is created exclusively by the
 * main session).
 */
export function buildChildLaunch(config: ChildLaunchConfig): {
	args: string[];
	env: NodeJS.ProcessEnv;
} {
	const args = [
		...config.piInvocation.args,
		"--mode", "rpc",
		"--no-extensions",
		// Base profile: bridge (ask/proxy plumbing) + web_search. Every child
		// gets both; `--no-extensions` keeps discovery off, so the base is the
		// only capability source for generic children.
		"-e", config.bridgePath,
		"-e", config.webSearchPath,
		// Provider entries sit between the base and the profile entries so the
		// RepoOwner handler order (reporting-bridge first, readiness last)
		// stays untouched regardless of how many packages resolve.
		...config.providerEntries.flatMap((entry) => ["-e", entry]),
	];
	// Per-spawn profile: extra extension entries are loaded into this child
	// only (`-e` is repeatable; `--no-extensions` keeps CLI paths). Profile
	// entries keep their order (reporting-bridge before task-workspace,
	// readiness probe last) — the base never perturbs it.
	for (const ext of config.additionalExtensions ?? []) {
		args.push("-e", ext);
	}
	args.push("--name", `subagent:${config.label}`);
	if (config.model) args.push("--model", config.model);
	if (config.thinking) args.push("--thinking", config.thinking);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SUBAGENT_ID: config.subagentId,
		PI_SUBAGENT_LABEL: config.label,
		PI_SUBAGENT_RESULTS_DIR: config.resultsDir,
	};
	// The inspection channel belongs only to this Pi process. Never inherit
	// its descriptors into either plain or workspace children.
	delete env.AGENTKIT_INSPECT_REQUEST_FD;
	delete env.AGENTKIT_INSPECT_RESPONSE_FD;
	return { args, env };
}

/** Project live stats onto the persisted result's token shape (cost rides along). */
function statsToResultTokens(stats?: SessionStats): AgentResult["tokens"] {
	if (!stats) return undefined;
	return { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total, cost: stats.cost };
}

function isTerminal(state: AgentState): state is AgentResult["status"] {
	return state === "completed" || state === "failed" || state === "cancelled";
}

/** The newest still-executing tool (Map preserves insertion order), id stripped. */
function newestActiveTool(activeTools: Map<string, ActiveToolEntry>): ToolActivity | undefined {
	let newest: ActiveToolEntry | undefined;
	for (const entry of activeTools.values()) newest = entry;
	if (!newest) return undefined;
	return { name: newest.name, summary: newest.summary, startedAt: newest.startedAt };
}
