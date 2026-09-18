/**
 * LocalSubagentRuntime — the local-process implementation of the subagent
 * runtime: model-facing semantics (spawn/steer/wait/…) over local child pi
 * processes speaking pi RPC.
 *
 * Each agent is an independent pi process in `--mode rpc` running with
 * `--no-extensions -e <bridge>` so children get a minimal, controlled
 * environment (no parent extension stack; a generic child cannot spawn
 * subagents at all — only a workspace worker carries the subagents index,
 * and its nested spawns are plain helpers only: workspace ownership is
 * created exclusively by the main session).
 *
 * Event flow (proven against pi 0.85.1):
 * - child `agent_start` -> authoritative run boundary: reset run-local state
 * - child settles  -> fetch state + final text + stats -> terminal result
 * - child exits before settling -> failed (never a stuck "running")
 * - child extension_ui_request (the `ask` tool) -> waiting_input; answered
 *   via extension_ui_response, which resumes the very same tool call. The
 *   pending question is cleared when the ask tool call ends, so an aborted
 *   or resolved dialog cannot desync the controller. The structured
 *   canonical request travels through the request payload losslessly.
 * - cancel -> RPC abort, then SIGTERM (pi exits cleanly even while blocked in
 *   a UI dialog), then SIGKILL escalation
 *
 * Input delivery (steer / follow_up) always goes through
 * `prompt` + `streamingBehavior`, letting pi — not a controller-side copy of
 * its state machine — atomically decide between queueing and a fresh run.
 *
 * Model-visible events are consumed by `wait()` first; events nobody waits on
 * are handed to background listeners (the extension delivers them to the main
 * model at the next safe boundary).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	RpcChildConnection,
	resolvePiInvocation,
	type SpawnFn,
} from "./rpc-child";
import { defaultResultsDir, loadResult, saveResult, sumSessionCost, summarizeText } from "./result-store";
import { parseReadinessPayload, type ReadinessPayload } from "./readiness";
import { ASK_WIRE_TITLE } from "./bridge-ask";
import { formatAskRequestFlat, parseAskRequest, type AskInput } from "../ask/contract";
import type {
	AgentResult,
	AgentSnapshot,
	AgentState,
	SessionStats,
	SpawnOptions,
	SubagentModelEvent,
	ToolActivity,
	WaitOutcome,
} from "./types";
import { summarizeToolActivity } from "./activity";

/** Live tool-activity bounds: status telemetry, never a log buffer. */
const ACTIVE_TOOLS_MAX = 8;
const RECENT_ACTIVITY_MAX = 4;

/** An active tool entry keeps its RPC correlation id internally. */
type ActiveToolEntry = ToolActivity & { toolCallId: string };

export interface ControllerOptions {
	/** Fallback cwd for children when spawn() has no cwd (main cwd). */
	defaultCwd: string;
	/** pi entry override for tests; defaults to resolved runtime invocation. */
	piCommand?: { command: string; args: string[] };
	/** Bridge extension file loaded into every child via `-e`. */
	bridgePath?: string;
	/** Base web-search extension entry loaded into every child via `-e` (tests override). */
	webSearchPath?: string;
	/** Results directory override (tests); defaults to the pi agent dir. */
	resultsDir?: string;
	/** Injected spawn (tests). */
	spawnFn?: SpawnFn;
	/** Grace period between SIGTERM and SIGKILL during cancel. */
	killGraceMs?: number;
	/** Max time to wait for the initial prompt to be accepted. */
	startTimeoutMs?: number;
	/** Max time to wait for a dispatch (steer/follow_up) preflight response. */
	dispatchTimeoutMs?: number;
	/** Max time to wait for the readiness handshake of profiled children. */
	readinessTimeoutMs?: number;
	/** Main session file persisted into results (per-session cost attribution). */
	parentSession?: string;
	/** Called whenever this session's subagent cost total changes. */
	onCostChange?: (total: number) => void;
}

interface AgentRecord {
	id: string;
	label: string;
	task: string;
	initialPrompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	state: AgentState;
	conn: RpcChildConnection;
	startedAt: number;
	endedAt?: number;
	lastActivityAt: number;
	sessionFile?: string;
	sessionId?: string;
	finalText?: string;
	/** Failure of the current run; cleared by `agent_start` and on success. */
	runError?: string;
	/** Process-level failure (spawn, watchdog, unexpected exit). */
	lastError?: string;
	/** Latest live session stats (tokens, cost, context fill); replaced wholesale on every report. */
	stats?: SessionStats;
	exitCode?: number | null;
	signal?: string | null;
	pendingQuestion?: { requestId: string; request: AskInput; question: string; askedAt: number };
	/** Tools currently executing, keyed by toolCallId (pi may run tools in parallel). */
	activeTools: Map<string, ActiveToolEntry>;
	/** Most recently finished tools, oldest first, hard-capped (RECENT_ACTIVITY_MAX). */
	recentActivity: ToolActivity[];
	cancelRequested: boolean;
	/**
	 * New work was dispatched (prompt + streamingBehavior) while the agent
	 * was in a terminal state. Until the child's `agent_start` proves the new
	 * run actually began, wait()/result() must not present the previous
	 * terminal result as the outcome of the pending work.
	 */
	pendingDispatch: boolean;
	/** True between child `agent_start` and the matching `agent_settled`. */
	runActive: boolean;
	waiters: Array<(outcome: WaitOutcome) => void>;
	spawnWaiters: Array<(ok: boolean) => void>;
	dispatchWaiters: Map<string, (ev: Record<string, unknown>) => void>;
	spawnSettled: boolean;
	settleFetchDone: boolean;
	/** Lifecycle events route to the workspace layer, not the generic policy. */
	eventRoute?: "workspace";
	/** Terminal retire requested: kill the process, keep the terminal record. */
	retireRequested: boolean;
	/** Readiness contract: entry id -> required tool names (handshake pending). */
	readinessExpected: Map<string, string[]>;
	readinessDone: boolean;
	acceptTimer?: NodeJS.Timeout;
	readinessTimer?: NodeJS.Timeout;
}

const ASK_TOOL = "ask";

export class LocalSubagentRuntime {
	private readonly records = new Map<string, AgentRecord>();
	private readonly listeners = new Set<(ev: SubagentModelEvent) => void>();
	private shutDown = false;

	private static idCounter = 0;

	private readonly piInvocation: { command: string; args: string[] };
	private readonly bridgePath: string;
	private readonly webSearchPath: string;
	private readonly spawnFn?: SpawnFn;
	private readonly defaultCwd: string;
	private readonly resultsDir: string;
	private readonly killGraceMs: number;
	private readonly startTimeoutMs: number;
	private readonly dispatchTimeoutMs: number;
	private readonly readinessTimeoutMs: number;
	private readonly workspaceListeners = new Set<(ev: SubagentModelEvent) => void>();
	/** Main session file written into persisted results (cost attribution). */
	private readonly parentSession?: string;
	private readonly onCostChange?: (total: number) => void;
	/** Cost of results already on disk for this session when the runtime started (resume). */
	private readonly persistedBaseCost: number;
	/** Latest cumulative cost reported per agent; the live part of the session total. */
	private readonly countedCost = new Map<string, number>();

	constructor(opts: ControllerOptions) {
		this.defaultCwd = opts.defaultCwd;
		this.piInvocation = opts.piCommand ?? resolvePiInvocation();
		this.bridgePath =
			opts.bridgePath ?? path.join(moduleDirname(), "bridge.ts");
		this.webSearchPath =
			opts.webSearchPath ?? path.join(moduleDirname(), "..", "web-search", "index.ts");
		this.spawnFn = opts.spawnFn;
		this.resultsDir = opts.resultsDir ?? defaultResultsDir();
		this.killGraceMs = opts.killGraceMs ?? 3000;
		this.startTimeoutMs = opts.startTimeoutMs ?? 30000;
		this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 10000;
		this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 15000;
		this.parentSession = opts.parentSession;
		this.onCostChange = opts.onCostChange;
		this.persistedBaseCost = this.parentSession
			? sumSessionCost(this.resultsDir, this.parentSession)
			: 0;
	}

	// ------------------------------------------------------------------ spawn

	spawn(opts: SpawnOptions): Promise<AgentSnapshot> {
		if (this.shutDown) return Promise.reject(new Error("runtime is shut down"));
		if (opts.signal?.aborted) {
			return Promise.reject(new Error("aborted before dispatch"));
		}
		const id = `sa-${++LocalSubagentRuntime.idCounter}-${Math.random().toString(36).slice(2, 6)}`;
		const cwd = path.resolve(this.defaultCwd, opts.cwd ?? ".");
		const label = opts.label?.trim() || `agent-${id.slice(3, 11)}`;

		const args = [
			...this.piInvocation.args,
			"--mode", "rpc",
			"--no-extensions",
			// Base profile: bridge (ask/proxy plumbing) + web_search. Every child
			// gets both; `--no-extensions` keeps discovery off, so the base is the
			// only capability source for generic children.
			"-e", this.bridgePath,
			"-e", this.webSearchPath,
		];
		// Per-spawn profile: extra extension entries are loaded into this child
		// only (`-e` is repeatable; `--no-extensions` keeps CLI paths). Profile
		// entries keep their order (reporting-bridge before task-workspace,
		// readiness probe last) — the base never perturbs it.
		for (const ext of opts.additionalExtensions ?? []) {
			args.push("-e", ext);
		}
		args.push("--name", `subagent:${label}`);
		if (opts.model) args.push("--model", opts.model);
		if (opts.thinking) args.push("--thinking", opts.thinking);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_SUBAGENT_ID: id,
			PI_SUBAGENT_LABEL: label,
			PI_SUBAGENT_RESULTS_DIR: this.resultsDir,
		};
		const readinessEntries = opts.readinessEntries ?? {};
		// The readiness contract stays MAIN-SIDE (this spawn's readinessEntries);
		// the child-side probe reports only the observed tool set, and the
		// controller judges it against this map. No readiness data travels to
		// the child: profiled and generic children get byte-identical
		// environments.

		const conn = new RpcChildConnection({
			command: this.piInvocation.command,
			args,
			cwd,
			env,
			spawnFn: this.spawnFn,
		});

		const record: AgentRecord = {
			id,
			label,
			task: opts.task,
			initialPrompt: opts.initialPrompt ?? opts.task,
			cwd,
			model: opts.model,
			thinking: opts.thinking,
			state: "starting",
			conn,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			activeTools: new Map(),
			recentActivity: [],
			cancelRequested: false,
			pendingDispatch: false,
			runActive: false,
			waiters: [],
			spawnWaiters: [],
			dispatchWaiters: new Map(),
			spawnSettled: false,
			settleFetchDone: false,
			eventRoute: opts.eventRoute,
			retireRequested: false,
			readinessExpected: new Map(Object.entries(readinessEntries)),
			readinessDone: false,
		};
		this.records.set(id, record);

		conn.onLine = (line) => this.handleChildLine(record, line);
		conn.onStderr = () => {
			record.lastActivityAt = Date.now();
		};
		conn.onError = (err) => {
			record.lastError = `spawn error: ${err.message}`;
			this.finishWithFailure(record, `spawn error: ${err.message}`);
		};
		conn.onExit = (info) => this.handleChildExit(record, info);

		// Pre-dispatch abort (N3): until the initial task prompt is RPC-
		// accepted, an abort kills the child and fails the spawn. After
		// acceptance the handler is inert (spawnSettled guard) — ownership of
		// the signal moves to the caller (abort = detach).
		const onSpawnAbort = () => {
			if (!record.spawnSettled) {
				this.failSpawn(record, "aborted before dispatch", "SIGKILL");
			}
		};
		opts.signal?.addEventListener("abort", onSpawnAbort, { once: true });

		if (record.readinessExpected.size > 0) {
			// Fail-closed dispatch: the task prompt is withheld until every
			// profiled extension confirmed initialization over the readiness
			// handshake, so a broken/missing extension can never reach the model.
			record.readinessTimer = setTimeout(() => {
				if (record.readinessDone || record.spawnSettled) return;
				this.failSpawn(record, "readiness handshake did not complete in time", "SIGKILL");
			}, this.readinessTimeoutMs);
			record.readinessTimer.unref?.();
		} else {
			this.sendInitialPrompt(record);
		}

		return new Promise<AgentSnapshot>((resolve, reject) => {
			record.spawnWaiters.push((ok) => {
				this.clearSpawnTimers(record);
				opts.signal?.removeEventListener("abort", onSpawnAbort);
				record.readinessDone = true;
				if (ok) resolve(this.snapshot(record));
				else reject(new Error(record.lastError ?? "child failed to start"));
			});
		});
	}

	// ------------------------------------------------------- child RPC plumbing

	/** Arm the acceptance timer and send the initial task prompt. */
	private sendInitialPrompt(record: AgentRecord): void {
		if (record.spawnSettled || record.conn.exit) return;
		record.acceptTimer = setTimeout(() => {
			if (!record.spawnSettled) {
				record.lastError = "child did not accept the initial prompt in time";
				this.finishWithFailure(record, record.lastError);
				this.conn(record).kill("SIGKILL");
			}
		}, this.startTimeoutMs);
		record.acceptTimer.unref?.();
		this.conn(record).send({ id: "spawn-prompt", type: "prompt", message: record.initialPrompt });
	}

	private clearSpawnTimers(record: AgentRecord): void {
		if (record.acceptTimer) clearTimeout(record.acceptTimer);
		if (record.readinessTimer) clearTimeout(record.readinessTimer);
	}

	/**
	 * Fail a spawn before dispatch: mark the spawn settled with failure,
	 * surface the terminal failure, and kill the child. The task prompt has
	 * not been sent (dispatched stays false).
	 */
	private failSpawn(record: AgentRecord, reason: string, signal?: string): void {
		if (record.spawnSettled) return;
		record.readinessDone = true;
		this.clearSpawnTimers(record);
		record.spawnSettled = true;
		record.lastError = reason;
		for (const w of record.spawnWaiters.splice(0)) w(false);
		this.finishWithFailure(record, reason);
		if (signal && !record.conn.exit) this.conn(record).kill(signal);
	}

	private handleChildLine(record: AgentRecord, line: string): void {
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line);
		} catch {
			return; // not protocol JSON — ignore
		}
		record.lastActivityAt = Date.now();
		const type = ev.type as string;

		if (type === "extension_ui_request") {
			this.handleUiRequest(record, ev);
			return;
		}
		// The ask tool call ended: the dialog was resolved one way or
		// another (answer, user dismiss, or an abort that never sends an
		// extension_ui_response). Sync the controller so the child cannot
		// leave a phantom pending question behind. Workspace-routed
		// children also learn about the resolution (input_resolved), so the
		// run registry stops reporting a question that is no longer pending.
		if (type === "tool_execution_start") {
			this.trackToolStart(record, ev);
			return;
		}
		if (type === "tool_execution_end") {
			this.trackToolEnd(record, ev);
			// The ask tool call ended: the dialog was resolved one way or
			// another (answer, user dismiss, or an abort that never sends an
			// extension_ui_response). Sync the controller so the child cannot
			// leave a phantom pending question behind. Workspace-routed
			// children also learn about the resolution (input_resolved), so the
			// run registry stops reporting a question that is no longer pending.
			if (ev.toolName === ASK_TOOL && record.pendingQuestion) {
				record.pendingQuestion = undefined;
				if (record.state === "waiting_input") record.state = "running";
				if (record.eventRoute === "workspace") {
					this.pushEvent(record, { kind: "input_resolved", agentId: record.id, label: record.label });
				}
			}
			return;
		}

		if (type === "agent_start") {
			// Authoritative run boundary: reset run-local state.
			record.runActive = true;
			record.runError = undefined;
			record.finalText = undefined;
			record.endedAt = undefined;
			record.pendingQuestion = undefined;
			record.pendingDispatch = false;
			record.activeTools.clear();
			record.recentActivity = [];
			if (!record.cancelRequested && record.state !== "starting") {
				record.state = "running";
			}
			return;
		}

		if (type === "agent_settled") {
			record.runActive = false;
			record.pendingQuestion = undefined;
			if (record.cancelRequested) return; // exit path will mark cancelled
			// Collect state, final text, and stats. Responses correlate by
			// command, so all three can go out at once.
			record.settleFetchDone = false;
			connGetState(record, "ctl-state");
			connGetStats(record);
			connGetLastText(record);
			return;
		}

		if (type === "response") {
			const dispatchWaiter = record.dispatchWaiters.get(ev.id as string);
			if (dispatchWaiter) {
				record.dispatchWaiters.delete(ev.id as string);
				dispatchWaiter(ev);
				return;
			}
			const cmd = ev.command as string;
			if (cmd === "prompt" && ev.id === "spawn-prompt") {
				if (!record.spawnSettled) {
					record.spawnSettled = true;
					record.state = "running";
					// Session identity is fetched EARLY (single RPC request, no
					// polling) so the live operator view can show the session id
					// while the child runs — not only after settlement.
					if (ev.success === true) connGetState(record, "ctl-state-early");
					for (const w of record.spawnWaiters.splice(0)) w(ev.success === true);
					if (ev.success !== true) {
						record.lastError = `initial prompt rejected: ${String(ev.error ?? "unknown")}`;
						this.finishWithFailure(record, record.lastError);
					}
				}
				return;
			}
			if (cmd === "get_state" && ev.success === true) {
				const data = ev.data as { sessionFile?: string; sessionId?: string } | undefined;
				record.sessionId = data?.sessionId ?? record.sessionId;
				// sessionFile is only taken from the settle-time fetch: pi creates
				// the file lazily (on the first persisted assistant message), so an
				// early path would dangle for children that die before then. Its
				// presence keeps meaning "a session file exists on disk".
				if (ev.id !== "ctl-state-early") {
					record.sessionFile = data?.sessionFile ?? record.sessionFile;
				}
				return;
			}
			if (cmd === "get_last_assistant_text" && ev.success === true) {
				record.finalText = (ev.data as { text?: string } | undefined)?.text ?? "";
				this.completeSettle(record);
				return;
			}
			if (cmd === "get_session_stats" && ev.success === true) {
				const data = ev.data as SessionStats | undefined;
				if (data?.tokens) {
					record.stats = {
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
					if (typeof data.cost === "number") {
						this.countedCost.set(record.id, data.cost);
						this.notifyCostChange();
					}
				}
				return;
			}
			return;
		}

		if (type === "message_end") {
			const msg = ev.message as
				| { role?: string; stopReason?: string; errorMessage?: string }
				| undefined;
			if (msg?.role === "assistant") {
				if (msg.stopReason === "error" && msg.errorMessage) {
					record.runError = msg.errorMessage;
				} else {
					// A successful assistant response supersedes any transient
					// provider error from an earlier retry attempt.
					record.runError = undefined;
				}
				// Live stats refresh: every completed assistant message moves the
				// cumulative token/cost/context numbers. Fire-and-forget — the
				// response handler is command-keyed and replaces record.stats.
				connGetStats(record);
			}
			return;
		}

		if (type === "auto_retry_end") {
			if (ev.success === false && typeof ev.finalError === "string") {
				record.runError = ev.finalError;
			} else if (ev.success === true) {
				record.runError = undefined;
			}
		}
	}

	/**
	 * Child UI dialogs. With the minimal child environment the dialog sources
	 * are the base bridge's ask tool (`input`, title "ask") and
	 * the readiness handshake of profiled children (fire-and-forget `notify`
	 * carrying the readiness payload, fired from session_start handlers —
	 * blocking dialogs would deadlock: the child's stdin reader only attaches
	 * after rebindSession completes). Fire-and-forget requests other than
	 * readiness notifies are ignored.
	 */
	private handleUiRequest(record: AgentRecord, ev: Record<string, unknown>): void {
		const method = ev.method as string;
		const id = ev.id as string;
		if (!id) return;
		if (method === "notify") {
			const payload = parseReadinessPayload(ev.message as string | undefined);
			if (payload) this.confirmReadiness(record, payload);
			return; // generic notifies are not dialogs
		}
		if (method !== "input") return; // select/confirm/editor are not produced by the bridge
		const title = ev.title as string;
		if (title !== ASK_WIRE_TITLE) return;
		// The payload is the child's structured canonical ask request; the
		// controller never flattens it — Main receives the original ids,
		// options, descriptions, previews, multi, and recommended flags.
		const request = parseAskRequest(ev.placeholder as string | undefined);
		if (!request) {
			// Unparseable payload: not produced by the current bridge. Fail
			// closed — cancel the dialog so the child tool gets "no answer"
			// instead of dead-waiting forever.
			this.conn(record).send({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		if (record.pendingQuestion) {
			// A previous question is still open: dismiss the duplicate so the
			// child tool gets "no answer" instead of dead-waiting forever.
			this.conn(record).send({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		record.pendingQuestion = {
			requestId: id,
			request,
			question: formatAskRequestFlat(request),
			askedAt: Date.now(),
		};
		record.state = "waiting_input";
		this.pushEvent(record, {
			kind: "needs_input",
			agentId: record.id,
			label: record.label,
			question: record.pendingQuestion.question,
			request,
		});
	}

	/**
	 * Readiness report (profiled children only): the child-side probe
	 * reported the tool set visible in the child session at session_start.
	 * The controller validates it against THIS spawn's readiness contract:
	 * any entry with missing required tools fails the spawn with the child
	 * killed and the task prompt never sent (dispatched:false, fail closed).
	 * All entries satisfied → the task prompt is sent (the dispatch point
	 * follows its acceptance).
	 */
	private confirmReadiness(record: AgentRecord, payload: ReadinessPayload): void {
		if (record.readinessDone || record.spawnSettled) return;
		if (record.readinessExpected.size === 0) return; // not a profiled spawn; ignore
		const problems: string[] = [];
		for (const [entry, required] of record.readinessExpected) {
			const missing = required.filter((t) => !payload.tools.includes(t));
			if (missing.length > 0) problems.push(`entry "${entry}" is missing required tools: ${missing.join(", ")}`);
		}
		if (problems.length > 0) {
			this.failSpawn(record, `readiness handshake failed: ${problems.join("; ")}`, "SIGKILL");
			return;
		}
		record.readinessDone = true;
		if (record.readinessTimer) clearTimeout(record.readinessTimer);
		this.sendInitialPrompt(record);
	}

	private handleChildExit(record: AgentRecord, info: { code: number | null; signal: string | null }): void {
		record.exitCode = info.code;
		record.signal = info.signal;
		record.endedAt = Date.now();
		record.pendingDispatch = false;
		// A dead child cannot be answered; drop any pending question so
		// snapshots of terminal agents do not show a stale dialog.
		record.pendingQuestion = undefined;
		if (!record.spawnSettled) {
			record.spawnSettled = true;
			record.lastError = record.lastError ?? `child exited before accepting the prompt (code ${info.code}, signal ${info.signal})`;
			for (const w of record.spawnWaiters.splice(0)) w(false);
			this.finishWithFailure(record, record.lastError);
			return;
		}
		if (record.cancelRequested) {
			this.markTerminal(record, "cancelled");
			this.pushEvent(record, { kind: "cancelled", agentId: record.id, label: record.label }, { background: false });
			return;
		}
		if (record.retireRequested) {
			// Terminal retire: the process is killed after a settled terminal
			// outcome. The record keeps its terminal state and result — retire
			// never turns a completed/failed record into cancelled.
			return;
		}
		if (record.runActive) {
			// A run was in progress and never settled.
			const reason = `child exited unexpectedly before completing (code ${info.code}, signal ${info.signal})`;
			record.lastError = reason;
			this.finishWithFailure(record, reason);
			return;
		}
		// All runs settled; a self-exit with a non-zero code or a kill signal
		// is still a process failure worth surfacing.
		if ((info.code ?? 0) !== 0 || info.signal) {
			record.lastError = `child exited with code ${info.code} / signal ${info.signal} after completing`;
			this.finishWithFailure(record, record.lastError);
		}
	}

	// Collect settle-time fetches, then decide the run outcome.
	private completeSettle(record: AgentRecord): void {
		if (record.settleFetchDone) return;
		record.settleFetchDone = true;
		if (record.cancelRequested) return;
		if (record.runError) {
			this.finishWithFailure(record, record.runError);
			return;
		}
		record.state = "completed";
		record.endedAt = Date.now();
		this.persistResult(record, "completed");
		this.pushEvent(record, {
			kind: "completed",
			agentId: record.id,
			label: record.label,
			summary: summarizeText(record.finalText),
		});
	}

	private finishWithFailure(record: AgentRecord, reason: string): void {
		if (isTerminal(record.state)) return;
		record.state = "failed";
		record.runError = reason;
		record.endedAt = Date.now();
		this.persistResult(record, "failed");
		this.pushEvent(record, { kind: "failed", agentId: record.id, label: record.label, reason });
	}

	private markTerminal(record: AgentRecord, state: "cancelled"): void {
		record.state = state;
		record.endedAt = record.endedAt ?? Date.now();
		this.persistResult(record, state);
	}

	private persistResult(record: AgentRecord, status: AgentResult["status"]): void {
		const result: AgentResult = {
			id: record.id,
			label: record.label,
			task: record.task,
			cwd: record.cwd,
			status,
			finalText: record.finalText,
			summary: summarizeText(record.finalText),
			failureReason: status === "failed" ? record.runError ?? record.lastError : undefined,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			model: record.model,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			tokens: statsToResultTokens(record.stats),
			exitCode: record.exitCode,
			signal: record.signal,
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
		};
		try {
			saveResult(result, this.resultsDir);
		} catch {
			// Persistence is best-effort; the in-memory record still serves results.
		}
	}

	// -------------------------------------------------------------- operations

	private conn(record: AgentRecord): RpcChildConnection {
		return record.conn;
	}

	async steer(agentId: string, message: string): Promise<void> {
		await this.dispatchInput(this.mustGet(agentId), "steer", message);
	}

	async followUp(agentId: string, message: string): Promise<void> {
		await this.dispatchInput(this.mustGet(agentId), "followUp", message);
	}

	/**
	 * Push the machine proxy preference to every live child by invoking the
	 * bridge's `proxy` command over the existing RPC prompt path. Fire per
	 * child with the normal dispatch timeout; a slow or dead child simply does
	 * not ack (children self-heal to the persisted preference on their next
	 * model request). Returns how many live children acknowledged.
	 */
	async pushProxyPreference(enabled: boolean): Promise<{ acked: number; total: number }> {
		const message = enabled ? "/proxy on" : "/proxy off";
		let acked = 0;
		let total = 0;
		for (const record of this.records.values()) {
			if (record.conn.exit) continue;
			total++;
			const id = `proxy-${++LocalSubagentRuntime.idCounter}`;
			try {
				const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
					const timer = setTimeout(() => {
						record.dispatchWaiters.delete(id);
						reject(new Error("proxy push not acknowledged in time"));
					}, this.dispatchTimeoutMs);
					timer.unref?.();
					record.dispatchWaiters.set(id, resolve);
					this.conn(record).send({ id, type: "prompt", message });
				});
				if (resp.success === true) acked++;
			} catch {
				// Unacked child keeps running; it converges on its next request.
			}
		}
		return { acked, total };
	}

	/**
	 * Deliver new input via `prompt` + `streamingBehavior`: pi atomically
	 * picks queueing vs a fresh run from the session's real state — no stale
	 * local copy.
	 *
	 * When the agent sits in a terminal state, the dispatch marks the old
	 * result stale (`pendingDispatch`) until the child's `agent_start` proves
	 * the new run began; wait()/result() must not hand back the previous
	 * completion as the outcome of the pending work. A rejected preflight
	 * clears the mark and surfaces the error to the caller.
	 */
	private async dispatchInput(
		record: AgentRecord,
		behavior: "steer" | "followUp",
		message: string,
	): Promise<void> {
		this.assertAlive(record, behavior === "steer" ? "steer" : "follow_up");
		const overTerminal = isTerminal(record.state);
		if (overTerminal) record.pendingDispatch = true;
		const id = `dispatch-${++LocalSubagentRuntime.idCounter}`;
		try {
			const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => {
					record.dispatchWaiters.delete(id);
					reject(new Error(`pi did not acknowledge the ${behavior} dispatch in time`));
				}, this.dispatchTimeoutMs);
				timer.unref?.();
				record.dispatchWaiters.set(id, resolve);
				this.conn(record).send({ id, type: "prompt", message, streamingBehavior: behavior });
			});
			if (resp.success !== true) {
				throw new Error(`pi rejected the ${behavior}: ${String(resp.error ?? "unknown")}`);
			}
		} catch (err) {
			if (overTerminal) record.pendingDispatch = false;
			throw err;
		}
	}

	private assertAlive(record: AgentRecord, op: string): void {
		if (record.conn.exit) {
			throw new Error(`cannot ${op}: agent ${agentRef(record)} process is not running (state: ${record.state})`);
		}
	}

	async wait(
		agentId: string,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome> {
		const record = this.mustGet(agentId);
		if (record.eventRoute === "workspace") {
			// Event ownership: wait() consumes the one lifecycle event; for a
			// workspace child that event belongs to the run registry. The
			// subagent tool rejects wait for workspace children; the runtime
			// enforces the same rule here (defense in depth).
			throw new Error(
				`agent ${agentId} is workspace-owned; the workspace spawn owns the run outcome — use op=status / op=result`,
			);
		}
		// Already meaningful: resolve from current state. A pending dispatch
		// invalidates the terminal result — it belongs to the previous run,
		// not to the work that was just queued.
		if (!record.pendingDispatch) {
			if (record.state === "waiting_input") {
				const pending = record.pendingQuestion;
				return {
					status: "needs_input",
					question: pending?.question ?? "(unknown question)",
					...(pending ? { request: pending.request } : {}),
				};
			}
			if (record.state === "completed") {
				return { status: "completed", summary: summarizeText(record.finalText) };
			}
			if (record.state === "failed") {
				return { status: "failed", reason: record.runError ?? record.lastError ?? "agent failed" };
			}
			if (record.state === "cancelled") {
				return { status: "cancelled" };
			}
		}
		const timeoutMs = opts?.timeoutMs ?? 600000;
		return new Promise<WaitOutcome>((resolve) => {
			let done = false;
			// Keep the exact wrapper so cleanup removes the registered entry,
			// not an unrelated function (a stale waiter would swallow the next
			// event — see pushEvent).
			let waiter: ((outcome: WaitOutcome) => void) | undefined;
			const finish = (outcome: WaitOutcome) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				if (waiter) {
					const idx = record.waiters.indexOf(waiter);
					if (idx !== -1) record.waiters.splice(idx, 1);
				}
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ status: "timeout", state: record.state }), timeoutMs);
			timer.unref?.();
			const onAbort = () => finish({ status: "timeout", state: record.state });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			waiter = (outcome) => finish(outcome);
			record.waiters.push(waiter);
		});
	}

	async result(agentId: string): Promise<AgentResult | null> {
		const record = this.records.get(agentId);
		if (!record) {
			// Unknown in this process (e.g. after a main restart) — try the
			// persisted file in the shared results dir.
			return loadResult(agentId, this.resultsDir);
		}
		if (!isTerminal(record.state) || record.pendingDispatch) return null; // no final result yet
		return this.recordToResult(record);
	}

	private recordToResult(record: AgentRecord): AgentResult {
		const status: AgentResult["status"] =
			record.state === "completed" ? "completed"
			: record.state === "cancelled" ? "cancelled"
			: "failed";
		return {
			id: record.id,
			label: record.label,
			task: record.task,
			cwd: record.cwd,
			status,
			finalText: record.finalText,
			summary: summarizeText(record.finalText),
			failureReason: status === "failed" ? record.runError ?? record.lastError : undefined,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			model: record.model,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			tokens: statsToResultTokens(record.stats),
			exitCode: record.exitCode,
			signal: record.signal,
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
		};
	}

	async respond(agentId: string, answer: string): Promise<void> {
		const record = this.mustGet(agentId);
		if (record.conn.exit) {
			throw new Error(`agent ${agentId} process has exited (state: ${record.state})`);
		}
		const q = record.pendingQuestion;
		if (!q) throw new Error(`agent ${agentId} has no pending question`);
		record.pendingQuestion = undefined;
		record.state = "running";
		if (record.eventRoute === "workspace") {
			this.pushEvent(record, { kind: "input_resolved", agentId: record.id, label: record.label });
		}
		this.conn(record).send({ type: "extension_ui_response", id: q.requestId, value: answer });
	}

	async cancel(agentId: string): Promise<void> {
		const record = this.mustGet(agentId);
		if (record.conn.exit) {
			if (!isTerminal(record.state)) this.markTerminal(record, "cancelled");
			return;
		}
		record.cancelRequested = true;
		// pi abort: ends the current run with stopReason "aborted"; the session
		// stays valid. Harmless when the child is idle or blocked in a dialog.
		// SIGTERM follows immediately: pi exits cleanly (exit code 143) even
		// while blocked inside an extension UI dialog.
		this.conn(record).send({ type: "abort" });
		this.conn(record).kill("SIGTERM");
		const escalated = await Promise.race([
			record.conn.waitForExit().then(() => false),
			new Promise<true>((resolve) => setTimeout(() => resolve(true), this.killGraceMs)),
		]);
		if (escalated && !record.conn.exit) {
			this.conn(record).kill("SIGKILL");
			await record.conn.waitForExit();
		}
	}

	/**
	 * Internal-only terminal termination (not exposed as a model-facing op):
	 * kill an already-settled child while PRESERVING its terminal record —
	 * state stays whatever settlement made it (e.g. completed) and the
	 * persisted result is untouched. Unlike cancel(), no cancelled status is
	 * written and no cancelled event is emitted.
	 */
	async retire(agentId: string): Promise<void> {
		const record = this.mustGet(agentId);
		if (record.conn.exit) return;
		record.retireRequested = true;
		// Abort is harmless for a settled child and covers the rare case of a
		// ladder follow-up having just started a new run.
		this.conn(record).send({ type: "abort" });
		this.conn(record).kill("SIGTERM");
		const escalated = await Promise.race([
			record.conn.waitForExit().then(() => false),
			new Promise<true>((resolve) => setTimeout(() => resolve(true), this.killGraceMs)),
		]);
		if (escalated && !record.conn.exit) {
			this.conn(record).kill("SIGKILL");
			await record.conn.waitForExit();
		}
	}

	inspect(agentId?: string): AgentSnapshot[] {
		const records = agentId ? [this.records.get(agentId)].filter(Boolean) as AgentRecord[] : [...this.records.values()];
		return records.map((r) => this.snapshot(r));
	}

	/** Results dir used for persisted results and envelope records (shared with children via env). */
	getResultsDir(): string {
		return this.resultsDir;
	}

	/**
	 * Session subagent cost total: results already on disk for this session
	 * (resume base) plus the latest cumulative cost reported by every agent
	 * of the live runtime. Children settled in this runtime are counted from
	 * memory only — their results were written after the base was computed.
	 */
	private notifyCostChange(): void {
		if (!this.onCostChange) return;
		let total = this.persistedBaseCost;
		for (const cost of this.countedCost.values()) total += cost;
		this.onCostChange(total);
	}

	onEvent(cb: (ev: SubagentModelEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/**
	 * Subscribe to lifecycle events of workspace-routed children (event
	 * ownership: every child has exactly one event owner — workspace children
	 * belong to the workspace run registry, generic children to the policy
	 * above). Events here never reach generic listeners or waiters.
	 */
	onWorkspaceEvent(cb: (ev: SubagentModelEvent) => void): () => void {
		this.workspaceListeners.add(cb);
		return () => this.workspaceListeners.delete(cb);
	}

	/** True when this agent's lifecycle events are owned by the workspace layer. */
	isWorkspaceRouted(agentId: string): boolean {
		return this.records.get(agentId)?.eventRoute === "workspace";
	}

	/** Kill all live children without latching the runtime shut. */
	async cancelAll(): Promise<void> {
		const live = [...this.records.values()].filter((r) => !r.conn.exit);
		if (live.length === 0) return;
		for (const r of live) {
			r.cancelRequested = true;
			this.conn(r).send({ type: "abort" });
			this.conn(r).kill("SIGTERM");
		}
		const exits = live.map((r) => r.conn.waitForExit());
		await Promise.race([
			Promise.all(exits),
			new Promise((resolve) => setTimeout(resolve, this.killGraceMs)),
		]);
		for (const r of live) {
			if (!r.conn.exit) this.conn(r).kill("SIGKILL");
		}
	}

	/** Kill all live children and latch the runtime shut (main shutdown). */
	async shutdown(): Promise<void> {
		this.shutDown = true;
		await this.cancelAll();
	}

	// ---------------------------------------------------------------- internal

	/**
	 * Authoritative child activity, distilled for the live operator view.
	 * tool_execution_start (name + conservatively summarized args) opens a
	 * bounded active window keyed by toolCallId; tool_execution_end closes it
	 * into the hard-capped recent list. Unmatched or id-less ends are ignored
	 * rather than guessed.
	 */
	private trackToolStart(record: AgentRecord, ev: Record<string, unknown>): void {
		const name = typeof ev.toolName === "string" && ev.toolName ? ev.toolName : "tool";
		const toolCallId = typeof ev.toolCallId === "string" && ev.toolCallId
			? ev.toolCallId
			: `unmatched-${Date.now()}-${record.activeTools.size}`;
		if (record.activeTools.size >= ACTIVE_TOOLS_MAX) {
			const oldest = record.activeTools.keys().next().value;
			if (oldest !== undefined) record.activeTools.delete(oldest);
		}
		record.activeTools.set(toolCallId, {
			toolCallId,
			name,
			// The child's cwd (managed worktree for workspace runs) lets the
			// summary stay workspace-relative instead of burning the cap on the
			// absolute worktree prefix.
			summary: summarizeToolActivity(name, ev.args, record.cwd),
			startedAt: Date.now(),
		});
	}

	private trackToolEnd(record: AgentRecord, ev: Record<string, unknown>): void {
		const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : undefined;
		if (toolCallId === undefined) return;
		const ended = record.activeTools.get(toolCallId);
		if (!ended) return;
		record.activeTools.delete(toolCallId);
		record.recentActivity.push({
			name: ended.name,
			summary: ended.summary,
			startedAt: ended.startedAt,
			endedAt: Date.now(),
		});
		if (record.recentActivity.length > RECENT_ACTIVITY_MAX) {
			record.recentActivity.splice(0, record.recentActivity.length - RECENT_ACTIVITY_MAX);
		}
		// Tool-reported nested LLM usage does not produce an assistant
		// message_end; refresh the live stats here as well (fire-and-forget).
		connGetStats(record);
	}

	private pushEvent(record: AgentRecord, ev: SubagentModelEvent, opts?: { background?: boolean }): void {
		// Event router: a workspace-routed child's lifecycle events belong to
		// the workspace run registry — waiters and generic listeners never see
		// them (the terminal surface is the shared [subagent completed] event).
		if (record.eventRoute === "workspace") {
			for (const cb of this.workspaceListeners) {
				try {
					cb(ev);
				} catch {
					// listener errors must not break the runtime
				}
			}
			return;
		}
		// A waiter gets it first (consumed); otherwise it goes to background
		// delivery. `background: false` events (cancel confirmations) resolve
		// waiters only — the cancelling side already learned the outcome
		// synchronously, and a duplicate steer message would just burn a turn.
		if (record.waiters.length > 0) {
			const waiter = record.waiters.shift()!;
			waiter(eventToOutcome(ev));
			// Other waiters (parallel tool calls) also get a copy.
			for (const w of record.waiters.splice(0)) w(eventToOutcome(ev));
			return;
		}
		if (opts?.background === false) return;
		for (const cb of this.listeners) {
			try {
				cb(ev);
			} catch {
				// listener errors must not break the runtime
			}
		}
	}

	private mustGet(agentId: string): AgentRecord {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`unknown agent id: ${agentId}`);
		return record;
	}

	private snapshot(record: AgentRecord): AgentSnapshot {
		return {
			id: record.id,
			label: record.label,
			state: record.state,
			task: record.task,
			cwd: record.cwd,
			model: record.model,
			thinking: record.thinking,
			alive: !record.conn.exit,
			pid: record.conn.pid,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			lastActivityAt: record.lastActivityAt,
			elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			pendingQuestion: record.pendingQuestion?.question,
			lastError: record.lastError ?? record.runError,
			stats: record.stats,
			exitCode: record.exitCode,
			signal: record.signal,
			activeTool: newestActiveTool(record),
			recentActivity: record.recentActivity.map((entry) => ({ ...entry })),
		};
	}
}

// -------------------------------------------------------------------- helpers

function agentRef(record: AgentRecord): string {
	return record.id;
}

function connGetState(record: AgentRecord, id = "ctl-state"): void {
	record.conn.send({ id, type: "get_state" });
}

function connGetStats(record: AgentRecord): void {
	record.conn.send({ id: "ctl-stats", type: "get_session_stats" });
}

function connGetLastText(record: AgentRecord): void {
	record.conn.send({ id: "ctl-last-text", type: "get_last_assistant_text" });
}

/** Project live stats onto the persisted result's token shape (cost rides along). */
function statsToResultTokens(stats?: SessionStats): AgentResult["tokens"] {
	if (!stats) return undefined;
	return { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total, cost: stats.cost };
}

function eventToOutcome(ev: SubagentModelEvent): WaitOutcome {
	switch (ev.kind) {
		case "completed":
			return { status: "completed", summary: ev.summary };
		case "failed":
			return { status: "failed", reason: ev.reason };
		case "cancelled":
			return { status: "cancelled" };
		case "needs_input":
			return { status: "needs_input", question: ev.question, request: ev.request };
		case "input_resolved":
			// Workspace-routed only; never reaches the waiter path.
			return { status: "timeout", state: "running" };
	}
}

function isTerminal(state: AgentState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

/** The newest still-executing tool (Map preserves insertion order), id stripped. */
function newestActiveTool(record: AgentRecord): ToolActivity | undefined {
	let newest: ActiveToolEntry | undefined;
	for (const entry of record.activeTools.values()) newest = entry;
	if (!newest) return undefined;
	return { name: newest.name, summary: newest.summary, startedAt: newest.startedAt };
}

/** Directory of this module (works under jiti and node). */
function moduleDirname(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		// jiti CJS interop fallback
		return __dirname;
	}
}
