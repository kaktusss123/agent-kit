/**
 * LocalSubagentRuntime — the local-process implementation of SubagentRuntime.
 *
 * Each agent is an independent pi process in `--mode rpc` running with
 * `--no-extensions -e <bridge>` so children get a minimal, controlled
 * environment (no recursive subagent spawning, no parent extension stack).
 *
 * Event flow (proven against pi 0.85.1):
 * - child settles  -> fetch state + final text + stats -> terminal result
 * - child exits before settling -> failed (never a stuck "running")
 * - child extension_ui_request (ask_parent) -> waiting_input; answered via
 *   extension_ui_response, which resumes the very same tool call
 * - cancel -> RPC abort, then SIGTERM (pi exits cleanly even while blocked in
 *   a UI dialog), then SIGKILL escalation
 *
 * Model-visible events are queued per agent. `wait()` consumes the next event
 * for its agent; events nobody waits on are handed to background listeners
 * (the extension delivers them to the main model at the next safe boundary).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	RpcChildConnection,
	resolvePiInvocation,
	type SpawnFn,
} from "./rpc-child";
import { loadResult, resultsDirFor, saveResult, summarizeText } from "./result-store";
import type {
	AgentResult,
	AgentSnapshot,
	AgentState,
	SpawnOptions,
	SubagentModelEvent,
	SubagentRuntime,
	WaitOutcome,
} from "./types";

export interface ControllerOptions {
	/** Fallback cwd for children when spawn() has no cwd (main cwd). */
	defaultCwd: string;
	/** pi entry override for tests; defaults to resolved runtime invocation. */
	piCommand?: { command: string; args: string[] };
	/** Bridge extension file loaded into every child via `-e`. */
	bridgePath?: string;
	/** Injected spawn (tests). */
	spawnFn?: SpawnFn;
	/** Grace period between SIGTERM and SIGKILL during cancel. */
	killGraceMs?: number;
	/** Max time to wait for the initial prompt to be accepted. */
	startTimeoutMs?: number;
}

interface AgentRecord {
	id: string;
	label: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	state: AgentState;
	conn: RpcChildConnection;
	resultsDir: string;
	startedAt: number;
	endedAt?: number;
	lastActivityAt: number;
	sessionFile?: string;
	sessionId?: string;
	finalText?: string;
	lastError?: string;
	tokens?: AgentResult["tokens"];
	exitCode?: number | null;
	signal?: string | null;
	pendingQuestion?: { requestId: string; question: string; askedAt: number };
	cancelRequested: boolean;
	settledOnce: boolean;
	waiters: Array<(outcome: WaitOutcome) => void>;
	spawnWaiters: Array<(ok: boolean) => void>;
	spawnSettled: boolean;
	settleFetchDone: boolean;
}

const ASK_PARENT_TITLE = "ask_parent";

export class LocalSubagentRuntime implements SubagentRuntime {
	private readonly records = new Map<string, AgentRecord>();
	private readonly listeners = new Set<(ev: SubagentModelEvent) => void>();
	private counter = 0;
	private shutDown = false;

	private readonly piInvocation: { command: string; args: string[] };
	private readonly bridgePath: string;
	private readonly spawnFn?: SpawnFn;
	private readonly defaultCwd: string;
	private readonly killGraceMs: number;
	private readonly startTimeoutMs: number;

	constructor(opts: ControllerOptions) {
		this.defaultCwd = opts.defaultCwd;
		this.piInvocation = opts.piCommand ?? resolvePiInvocation();
		this.bridgePath =
			opts.bridgePath ?? path.join(moduleDirname(), "bridge.ts");
		this.spawnFn = opts.spawnFn;
		this.killGraceMs = opts.killGraceMs ?? 3000;
		this.startTimeoutMs = opts.startTimeoutMs ?? 30000;
	}

	// ------------------------------------------------------------------ spawn

	spawn(opts: SpawnOptions): Promise<AgentSnapshot> {
		if (this.shutDown) return Promise.reject(new Error("runtime is shut down"));
		const id = `sa-${counterId()}-${Math.random().toString(36).slice(2, 6)}`;
		const cwd = path.resolve(this.defaultCwd, opts.cwd ?? ".");
		const label = opts.label?.trim() || `agent-${id.slice(3, 11)}`;

		const args = [
			...this.piInvocation.args,
			"--mode", "rpc",
			"--no-extensions",
			"-e", this.bridgePath,
			"--name", `subagent:${label}`,
		];
		if (opts.model) args.push("--model", opts.model);
		if (opts.thinking) args.push("--thinking", opts.thinking);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_SUBAGENT_ID: id,
			PI_SUBAGENT_LABEL: label,
		};

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
			cwd,
			model: opts.model,
			thinking: opts.thinking,
			state: "starting",
			conn,
			resultsDir: resultsDirFor(cwd),
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			cancelRequested: false,
			settledOnce: false,
			waiters: [],
			spawnWaiters: [],
			spawnSettled: false,
			settleFetchDone: false,
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

		conn.send({ id: "spawn-prompt", type: "prompt", message: opts.task });

		const startTimer = setTimeout(() => {
			if (!record.spawnSettled) {
				record.lastError = "child did not accept the initial prompt in time";
				this.finishWithFailure(record, record.lastError);
				conn.kill("SIGKILL");
			}
		}, this.startTimeoutMs);
		// Let the event loop die with the process instead of keeping it alive.
		startTimer.unref?.();

		return new Promise<AgentSnapshot>((resolve, reject) => {
			record.spawnWaiters.push((ok) => {
				clearTimeout(startTimer);
				if (ok) resolve(this.snapshot(record));
				else reject(new Error(record.lastError ?? "child failed to start"));
			});
		});
	}

	// ------------------------------------------------------- child RPC plumbing

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

		if (type === "response") {
			const cmd = ev.command as string;
			if (cmd === "prompt" && ev.id === "spawn-prompt") {
				if (!record.spawnSettled) {
					record.spawnSettled = true;
					record.state = "running";
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
				record.sessionFile = data?.sessionFile ?? record.sessionFile;
				record.sessionId = data?.sessionId ?? record.sessionId;
				return;
			}
			if (cmd === "get_last_assistant_text" && ev.success === true) {
				record.finalText = (ev.data as { text?: string } | undefined)?.text ?? "";
				this.completeSettle(record);
				return;
			}
			if (cmd === "get_session_stats" && ev.success === true) {
				const data = ev.data as
					| { tokens?: { input?: number; output?: number; total?: number }; cost?: number }
					| undefined;
				if (data?.tokens) {
					record.tokens = {
						input: data.tokens.input ?? 0,
						output: data.tokens.output ?? 0,
						total: data.tokens.total ?? 0,
						cost: data.cost,
					};
				}
				return;
			}
			return;
		}

		if (type === "agent_settled") {
			record.settledOnce = true;
			if (record.cancelRequested) return; // exit path will mark cancelled
			// Collect state, final text, and stats. Responses correlate by
			// command, so all three can go out at once.
			record.settleFetchDone = false;
			connGetState(record);
			connGetStats(record);
			connGetLastText(record);
			return;
		}

		if (type === "message_end") {
			const msg = ev.message as
				| { role?: string; stopReason?: string; errorMessage?: string }
				| undefined;
			if (msg?.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
				record.lastError = msg.errorMessage;
			}
			return;
		}

		if (type === "auto_retry_end") {
			if (ev.success === false && typeof ev.finalError === "string") {
				record.lastError = ev.finalError;
			}
		}
	}

	/**
	 * Child UI dialogs. With the minimal child environment the only dialog
	 * source is the bridge's ask_parent tool (`input`, title "ask_parent").
	 * Fire-and-forget requests (notify, setWidget, ...) are ignored.
	 */
	private handleUiRequest(record: AgentRecord, ev: Record<string, unknown>): void {
		const method = ev.method as string;
		if (method !== "input") return; // select/confirm/editor are not produced by the bridge
		const title = ev.title as string;
		const id = ev.id as string;
		if (title !== ASK_PARENT_TITLE || !id) return;
		const question = (ev.placeholder as string) ?? "";
		if (record.pendingQuestion) {
			// A previous question is still open: dismiss the duplicate so the
			// child tool gets "no answer" instead of dead-waiting forever.
			this.conn(record).send({ type: "extension_ui_response", id, cancelled: true });
			return;
		}
		record.pendingQuestion = { requestId: id, question, askedAt: Date.now() };
		record.state = "waiting_input";
		this.pushEvent(record, { kind: "needs_input", agentId: record.id, label: record.label, question });
	}

	private handleChildExit(record: AgentRecord, info: { code: number | null; signal: string | null }): void {
		record.exitCode = info.code;
		record.signal = info.signal;
		record.endedAt = Date.now();
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
		if (!record.settledOnce) {
			this.finishWithFailure(
				record,
				`child exited unexpectedly before completing (code ${info.code}, signal ${info.signal})`,
			);
			return;
		}
		// Settled, then the process ended on its own (normal RPC shutdown is
		// controller-driven; any self-exit here is only a problem if it carries
		// a non-zero code — the result was already captured at settle time).
		if ((info.code ?? 0) !== 0) {
			record.lastError = record.lastError ?? `child exited with code ${info.code} after completing`;
			this.finishWithFailure(record, record.lastError);
		}
	}

	// Wait for settle-time fetches (state + final text) before emitting results.
	private completeSettle(record: AgentRecord): void {
		if (record.settleFetchDone) return;
		record.settleFetchDone = true;
		if (record.cancelRequested) return;
		if (record.lastError) {
			this.finishWithFailure(record, record.lastError);
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
		record.lastError = reason;
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
			failureReason: status === "failed" ? record.lastError : undefined,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			model: record.model,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			tokens: record.tokens,
			exitCode: record.exitCode,
			signal: record.signal,
		};
		try {
			saveResult(result, record.resultsDir);
		} catch {
			// Persistence is best-effort; the in-memory record still serves results.
		}
	}

	// -------------------------------------------------------------- operations

	private conn(record: AgentRecord): RpcChildConnection {
		return record.conn;
	}

	async steer(agentId: string, message: string): Promise<void> {
		const record = this.mustGet(agentId);
		if (record.state !== "running") {
			throw new Error(
				`agent ${agentId} is ${record.state}, not running — steer needs an active run (use follow_up instead)`,
			);
		}
		this.conn(record).send({ id: `steer-${Date.now()}`, type: "steer", message });
	}

	async followUp(agentId: string, message: string): Promise<void> {
		const record = this.mustGet(agentId);
		if (record.state === "waiting_input") {
			throw new Error(`agent ${agentId} is waiting for input — answer with subagent respond first`);
		}
		if (!record.conn.pid || record.conn.exit) {
			throw new Error(`agent ${agentId} process is not running (state: ${record.state})`);
		}
		if (record.state === "running" || record.state === "starting") {
			this.conn(record).send({ id: `followup-${Date.now()}`, type: "follow_up", message });
			return;
		}
		// pi queues follow_up forever on an idle agent (verified in 0.85.1),
		// so resuming an idle child is a plain prompt in the same session.
		record.state = "running";
		record.endedAt = undefined;
		this.conn(record).send({ id: `resume-${Date.now()}`, type: "prompt", message });
	}

	async wait(
		agentId: string,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome> {
		const record = this.mustGet(agentId);
		// Already meaningful: resolve from current state.
		if (record.state === "waiting_input") {
			return { status: "needs_input", question: record.pendingQuestion?.question ?? "(unknown question)" };
		}
		if (record.state === "completed") {
			return { status: "completed", summary: summarizeText(record.finalText) };
		}
		if (record.state === "failed") {
			return { status: "failed", reason: record.lastError ?? "agent failed" };
		}
		if (record.state === "cancelled") {
			return { status: "cancelled" };
		}
		const timeoutMs = opts?.timeoutMs ?? 600000;
		return new Promise<WaitOutcome>((resolve) => {
			let done = false;
			const finish = (outcome: WaitOutcome) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				const idx = record.waiters.indexOf(resolve);
				if (idx !== -1) record.waiters.splice(idx, 1);
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ status: "timeout", state: record.state }), timeoutMs);
			timer.unref?.();
			const onAbort = () => finish({ status: "timeout", state: record.state });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			record.waiters.push((outcome) => finish(outcome));
		});
	}

	async result(agentId: string): Promise<AgentResult | null> {
		const record = this.records.get(agentId);
		if (!record) {
			// Unknown in this process (e.g. after a main restart) — try the
			// persisted file in the current workspace's results dir.
			return loadResult(agentId, resultsDirFor(this.defaultCwd));
		}
		if (!isTerminal(record.state)) return null; // no final result yet
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
			failureReason: status === "failed" ? record.lastError : undefined,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			model: record.model,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			tokens: record.tokens,
			exitCode: record.exitCode,
			signal: record.signal,
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

	inspect(agentId?: string): AgentSnapshot[] {
		const records = agentId ? [this.records.get(agentId)].filter(Boolean) as AgentRecord[] : [...this.records.values()];
		return records.map((r) => this.snapshot(r));
	}

	onEvent(cb: (ev: SubagentModelEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	async shutdown(): Promise<void> {
		this.shutDown = true;
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

	// ---------------------------------------------------------------- internal

	private pushEvent(record: AgentRecord, ev: SubagentModelEvent, opts?: { background?: boolean }): void {
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
			alive: !record.conn.exit,
			pid: record.conn.pid,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			lastActivityAt: record.lastActivityAt,
			elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
			sessionFile: record.sessionFile,
			sessionId: record.sessionId,
			pendingQuestion: record.pendingQuestion?.question,
			lastError: record.lastError,
			exitCode: record.exitCode,
			signal: record.signal,
		};
	}
}

// -------------------------------------------------------------------- helpers

function connGetState(record: AgentRecord): void {
	record.conn.send({ id: "ctl-state", type: "get_state" });
}

function connGetStats(record: AgentRecord): void {
	record.conn.send({ id: "ctl-stats", type: "get_session_stats" });
}

function connGetLastText(record: AgentRecord): void {
	record.conn.send({ id: "ctl-last-text", type: "get_last_assistant_text" });
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
			return { status: "needs_input", question: ev.question };
	}
}

function isTerminal(state: AgentState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

let idCounter = 0;
function counterId(): number {
	return ++idCounter;
}

/** Directory of this module (works under jiti and node). */
function moduleDirname(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		// jiti CJS interop fallback
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return __dirname;
	}
}
