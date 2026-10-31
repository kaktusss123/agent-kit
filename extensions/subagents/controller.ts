/**
 * LocalSubagentRuntime — the local-process implementation of the subagent
 * runtime: the COLLECTION of child agents behind model-facing semantics
 * (spawn/steer/wait/…).
 *
 * Each child is an independent pi process in `--mode rpc`, owned by one
 * ChildAgentProcess (its RPC, readiness handshake, dispatch preflight,
 * questions, timers, cancellation and settlement). This class owns what
 * belongs to the collection: the agent list, user operations across agents,
 * event and result routing, persistence, cost rollup, and the shutdown of
 * every child.
 *
 * Model-visible events are consumed by `wait()` first; events nobody waits on
 * are handed to background listeners (the extension delivers them to the main
 * model at the next safe boundary). Workspace-routed children have exactly one
 * event owner — the workspace run registry — so neither generic waiters nor
 * generic listeners ever see their lifecycle.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiInvocation, type SpawnFn } from "./rpc-child.ts";
import {
	buildChildLaunch,
	ChildAgentProcess,
	type ChildAgentHost,
	type ChildAgentSpec,
	type ChildMarkerFacts,
	type ChildResultFacts,
	type ChildTimeouts,
} from "./child-process.ts";
import { defaultResultsDir, listAllResults, loadResult, saveResult, sumSessionCost, summarizeText } from "./result-store.ts";
import type {
	AgentResult,
	AgentSnapshot,
	ForeignRunningMarker,
	SpawnOptions,
	SubagentModelEvent,
	WaitOutcome,
} from "./types.ts";
import { loadProgress, type RunHistory } from "./progress.ts";
import { validateLastAssistantText } from "./last-text.ts";

/**
 * Default idle-exit delay (F003): settled children are plain RPC processes
 * that never exit on their own; after this long in a terminal state their
 * process is retired (terminal record preserved). Generous, because steer /
 * follow_up legitimately reuse completed children — any dispatch disarms
 * the timer. Per-spawn `idleExitMs` overrides; `<= 0` disables.
 */
const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;

export interface ControllerOptions {
	/** Fallback cwd for children when spawn() has no cwd (main cwd). */
	defaultCwd: string;
	/** pi entry override for tests; defaults to resolved runtime invocation. */
	piCommand?: { command: string; args: string[] };
	/** Bridge extension file loaded into every child via `-e`. */
	bridgePath?: string;
	/** Base web-search extension entry loaded into every child via `-e` (tests override). */
	webSearchPath?: string;
	/**
	 * Parent-side provider-extension resolution for the child model
	 * ("provider/id"). Returns local extension entry paths to load via `-e`, or
	 * throws ProviderExtensionError when the model's provider is
	 * extension-registered in this session but no installed package provides
	 * entries (fail fast: no process is created). Wired by the host extension
	 * from live parent facts; tests inject fakes.
	 */
	providerResolution?: (model: string) => string[];
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
	/**
	 * Default idle-exit delay for settled children (F003); per-spawn
	 * `idleExitMs` overrides. Defaults to 30 minutes; `<= 0` disables.
	 */
	defaultIdleExitMs?: number;
}

/** One waiter of `wait()`; kept here because wait() is a collection operation. */
type Waiter = (outcome: WaitOutcome) => void;

export class LocalSubagentRuntime {
	private readonly children = new Map<string, ChildAgentProcess>();
	/** Pending model-facing waits, per agent (all waiters of one event get a copy). */
	private readonly waiters = new Map<string, Waiter[]>();
	/** Workspace run history per child; persisted with results, never executed. */
	private readonly runHistories = new Map<string, RunHistory>();
	private readonly listeners = new Set<(ev: SubagentModelEvent) => void>();
	private shutDown = false;

	private static idCounter = 0;

	private readonly piInvocation: { command: string; args: string[] };
	private readonly bridgePath: string;
	private readonly webSearchPath: string;
	private readonly providerResolution?: (model: string) => string[];
	private readonly spawnFn?: SpawnFn;
	private readonly defaultCwd: string;
	private readonly resultsDir: string;
	private readonly timeouts: ChildTimeouts;
	private readonly workspaceListeners = new Set<(ev: SubagentModelEvent) => void>();
	/**
	 * Runtime-wide record mutation listeners (running-agents push and future
	 * telemetry). Notifications are advisory and cheap: subscribers recompute
	 * from `inspect()`, and a subscriber error is swallowed.
	 */
	private readonly recordsListeners = new Set<() => void>();
	/** Main session file written into persisted results (cost attribution). */
	private readonly parentSession?: string;
	private readonly onCostChange?: (total: number) => void;
	/** Cost of results already on disk for this session when the runtime started (resume). */
	private readonly persistedBaseCost: number;
	/** Latest cumulative cost reported per agent; the live part of the session total. */
	private readonly countedCost = new Map<string, number>();
	/** Default idle-exit delay for settled children (per-spawn idleExitMs overrides). */
	private readonly defaultIdleExitMs: number;

	constructor(opts: ControllerOptions) {
		this.defaultCwd = opts.defaultCwd;
		this.piInvocation = opts.piCommand ?? resolvePiInvocation();
		this.bridgePath =
			opts.bridgePath ?? path.join(moduleDirname(), "bridge.ts");
		this.webSearchPath =
			opts.webSearchPath ?? path.join(moduleDirname(), "..", "web-search", "index.ts");
		this.providerResolution = opts.providerResolution;
		this.spawnFn = opts.spawnFn;
		this.resultsDir = opts.resultsDir ?? defaultResultsDir();
		this.timeouts = {
			killGraceMs: opts.killGraceMs ?? 3000,
			startMs: opts.startTimeoutMs ?? 30000,
			dispatchMs: opts.dispatchTimeoutMs ?? 10000,
			readinessMs: opts.readinessTimeoutMs ?? 15000,
		};
		this.parentSession = opts.parentSession;
		this.onCostChange = opts.onCostChange;
		this.persistedBaseCost = this.parentSession
			? sumSessionCost(this.resultsDir, this.parentSession)
			: 0;
		this.defaultIdleExitMs = opts.defaultIdleExitMs ?? DEFAULT_IDLE_EXIT_MS;
		// Startup reconciliation (F003): spawn-time markers of THIS session
		// whose child never produced a terminal result mean the child was lost
		// to an ungraceful parent death. Finalize them before anything can
		// observe the results dir. No live processes exist yet.
		this.reconcileLostChildren();
	}

	// ------------------------------------------------------------------ spawn

	/**
	 * Async so EVERY failure path (including the pre-spawn provider
	 * resolution) reaches callers as a rejected promise — never a synchronous
	 * throw from a method typed `Promise<...>`.
	 */
	async spawn(opts: SpawnOptions): Promise<AgentSnapshot> {
		if (this.shutDown) throw new Error("runtime is shut down");
		if (opts.signal?.aborted) {
			throw new Error("aborted before dispatch");
		}
		const id = `sa-${++LocalSubagentRuntime.idCounter}-${Math.random().toString(36).slice(2, 6)}`;
		const cwd = path.resolve(this.defaultCwd, opts.cwd ?? ".");
		const label = opts.label?.trim() || `agent-${id.slice(3, 11)}`;

		// Provider propagation (common spawn path: Main -> plain, Main ->
		// RepoOwner, RepoOwner -> plain). A child model whose provider is
		// extension-registered in this session needs the provider's extension
		// entries passed explicitly (`--no-extensions` children would die before
		// RPC with `Model "..." not found`). Resolution is read-only; a needed-
		// but-missing provider fails fast here, BEFORE process creation.
		const providerEntries = opts.model && this.providerResolution
			? this.providerResolution(opts.model)
			: [];

		const launch = buildChildLaunch({
			piInvocation: this.piInvocation,
			bridgePath: this.bridgePath,
			webSearchPath: this.webSearchPath,
			providerEntries,
			additionalExtensions: opts.additionalExtensions,
			label,
			model: opts.model,
			thinking: opts.thinking,
			resultsDir: this.resultsDir,
			subagentId: id,
		});

		// The readiness contract stays MAIN-SIDE (this spawn's readinessEntries);
		// the child-side probe reports only the observed tool set, and the
		// controller judges it against this map. No readiness data travels to
		// the child: profiled and generic children get byte-identical
		// environments.
		const spec: ChildAgentSpec = {
			id,
			label,
			task: opts.task,
			initialPrompt: opts.initialPrompt ?? opts.task,
			cwd,
			model: opts.model,
			thinking: opts.thinking,
			command: this.piInvocation.command,
			args: launch.args,
			env: launch.env,
			spawnFn: this.spawnFn,
			readinessEntries: opts.readinessEntries,
			eventRoute: opts.eventRoute,
			idleExitMs: opts.idleExitMs ?? this.defaultIdleExitMs,
			onAccepted: opts.onAccepted,
		};
		const host: ChildAgentHost = {
			emit: (ev, routeOpts) => this.routeEvent(id, opts.eventRoute, ev, routeOpts),
			changed: () => this.notifyRecordsChanged(),
			persistResult: (facts) => this.writeResult(facts),
			persistMarker: (facts) => this.writeMarker(facts),
			costReported: (agentId, cost) => this.recordCost(agentId, cost),
		};

		const child = new ChildAgentProcess(spec, this.timeouts, host);
		this.children.set(id, child);
		opts.onCreated?.(child.snapshot());
		this.notifyRecordsChanged();

		// Spawn-time partial marker (F003): persist a minimal "running" record
		// AT process creation. If the parent dies before the child settles,
		// startup reconciliation turns this marker into a failed result; the
		// terminal write at settle supersedes it in place (same file).
		this.writeMarker(child.markerFacts());

		return child.start(opts.signal);
	}

	// -------------------------------------------------------------- operations

	async steer(agentId: string, message: string): Promise<void> {
		const child = this.mustGet(agentId);
		if (child.eventRoute === "workspace") {
			if (!child.canAcceptQueuedSteer()) {
				throw new Error(`cannot steer workspace-owned agent ${agentId}: run is settling or terminating`);
			}
			// Queue-only RPC, never prompt: an idle race must not start a new run
			// or execute an extension command. Pi delivers at the safe tool boundary.
			await child.dispatch("steer", message, true);
			return;
		}
		await child.dispatch("steer", message);
	}

	/**
	 * Queue a follow-up. Returns the agent that owns the work: normally the
	 * SAME agent (pi atomically queues the input or starts a fresh run).
	 * When the child process is already gone (idle exit retired the settled
	 * child, or it died after settling) the follow-up degrades gracefully to
	 * a FRESH spawn with the message as its task instead of erroring — queued
	 * work survives the reap. The caller must track the returned agent id.
	 */
	async followUp(agentId: string, message: string): Promise<{ agentId: string; respawned: boolean }> {
		const child = this.mustGet(agentId);
		if ((!child.alive || child.retiring) && child.settled) {
			if (child.eventRoute === "workspace") throw new Error("workspace-owned agents cannot restart through follow_up");
			const fresh = await this.spawn({
				task: message,
				label: child.label,
				cwd: child.cwd,
				model: child.model,
				thinking: child.thinking,
				idleExitMs: child.idleExit,
				eventRoute: child.eventRoute,
			});
			return { agentId: fresh.id, respawned: true };
		}
		await child.dispatch("followUp", message);
		return { agentId, respawned: false };
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
		for (const child of this.children.values()) {
			if (!child.alive) continue;
			total++;
			if (await child.pushCommand(message)) acked++;
		}
		return { acked, total };
	}

	async wait(
		agentId: string,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome> {
		const child = this.mustGet(agentId);
		if (child.eventRoute === "workspace") {
			// Event ownership: wait() consumes the one lifecycle event; for a
			// workspace child that event belongs to the run registry. The
			// subagent tool routes workspace wait through its registry; direct
			// generic waits remain forbidden here (defense in depth).
			throw new Error(
				`agent ${agentId} is workspace-owned; use the workspace registry wait or op=status / op=result`,
			);
		}
		// Already meaningful: resolve from current state. A pending dispatch
		// invalidates the terminal result — it belongs to the previous run,
		// not to the work that was just queued.
		const immediate = child.outcome();
		if (immediate) return immediate;

		const timeoutMs = opts?.timeoutMs ?? 600000;
		return new Promise<WaitOutcome>((resolve) => {
			let done = false;
			// Keep the exact wrapper so cleanup removes the registered entry,
			// not an unrelated function (a stale waiter would swallow the next
			// event — see routeEvent).
			let waiter: Waiter | undefined;
			const finish = (outcome: WaitOutcome) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				if (waiter) {
					const list = this.waiters.get(agentId);
					if (list) {
						const idx = list.indexOf(waiter);
						if (idx !== -1) list.splice(idx, 1);
						if (list.length === 0) this.waiters.delete(agentId);
					}
				}
				resolve(outcome);
			};
			const timer = setTimeout(() => finish({ status: "timeout", state: child.currentState }), timeoutMs);
			timer.unref?.();
			const onAbort = () => finish({ status: "timeout", state: child.currentState });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			waiter = (outcome) => finish(outcome);
			const list = this.waiters.get(agentId);
			if (list) list.push(waiter);
			else this.waiters.set(agentId, [waiter]);
		});
	}

	async result(agentId: string): Promise<AgentResult | null> {
		const child = this.children.get(agentId);
		if (!child) {
			// Unknown in this process (e.g. after a main restart) — try the
			// persisted file in the shared results dir. A "running" spawn marker
			// is NOT a final result: it belongs to a live child of another
			// session (or awaits reconciliation) and must never surface as an
			// outcome.
			const persisted = loadResult(agentId, this.resultsDir);
			return persisted && isTerminalStatus(persisted.status) ? persisted : null;
		}
		if (!child.hasFinalResult()) return null; // no final result yet
		const facts = child.terminalFacts();
		return facts ? this.toAgentResult(facts) : null;
	}

	async respond(agentId: string, answer: string): Promise<void> {
		this.mustGet(agentId).respond(answer);
	}

	async cancel(agentId: string): Promise<void> {
		await this.mustGet(agentId).cancel();
	}

	/**
	 * Internal-only terminal termination (not exposed as a model-facing op):
	 * kill an already-settled child while PRESERVING its terminal record —
	 * state stays whatever settlement made it (e.g. completed) and the
	 * persisted result is untouched. Unlike cancel(), no cancelled status is
	 * written and no cancelled event is emitted.
	 */
	async retire(agentId: string): Promise<void> {
		await this.mustGet(agentId).retire();
	}

	inspect(agentId?: string): AgentSnapshot[] {
		const children = agentId
			? [this.children.get(agentId)].filter(Boolean) as ChildAgentProcess[]
			: [...this.children.values()];
		return children.map((c) => c.snapshot());
	}

	/** Results dir used for persisted results and envelope records (shared with children via env). */
	getResultsDir(): string {
		return this.resultsDir;
	}

	/**
	 * Spawn-time markers of OTHER sessions still in "running" state on disk
	 * (F003 reconciliation): orphans whose owning parent is gone or whose
	 * registry died with it. This session never rewrites them — they are
	 * surfaced (op=status --all) so an operator can act on them. Markers of
	 * THIS session are not listed: startup reconciliation already finalized
	 * them, and live children of this runtime appear in inspect().
	 */
	listForeignRunningMarkers(): ForeignRunningMarker[] {
		return runningMarkers(this.resultsDir)
			.filter((m) => m.parentSession !== this.parentSession)
			.map((m) => ({
				id: m.id,
				label: m.label ?? m.id,
				task: m.task ?? "",
				startedAt: m.startedAt ?? 0,
				...(m.pid !== undefined ? { pid: m.pid } : {}),
				ageMs: Math.max(0, Date.now() - (m.startedAt ?? Date.now())),
			}))
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	/**
	 * Startup reconciliation (F003/F014): scan the shared results dir for
	 * spawn-time markers. A "running" marker of THIS parent session means
	 * its child never produced a terminal result — the only way that happens
	 * is an ungraceful parent death (session_shutdown always cancelAll()s).
	 * Finalize the marker as failed so the lost child never stays a phantom
	 * "running" entry. Markers of other sessions are foreign orphans — left
	 * untouched (see listForeignRunningMarkers). Terminal results are not
	 * markers; they are left exactly as settled.
	 */
	private reconcileLostChildren(): void {
		for (const marker of runningMarkers(this.resultsDir)) {
			if (marker.parentSession !== this.parentSession) continue;
			const progress = loadProgress(marker.id, this.resultsDir) ?? marker.run?.progress;
			// Malformed optional fields are dropped, never forwarded: the lost
			// record keeps the last PUBLIC speech only when it is well-formed.
			const { lastAssistantText: rawLastText, ...markerFields } = marker;
			const lastText = validateLastAssistantText(rawLastText);
			const finalized: AgentResult = {
				...markerFields,
				...(marker.run ? { run: { ...marker.run, state: "lost", ...(progress ? { progress } : {}) } } : {}),
				...(lastText ? { lastAssistantText: lastText } : {}),
				status: "failed",
				failureReason: "child lost across parent restart",
				endedAt: Date.now(),
			};
			try {
				saveResult(finalized, this.resultsDir);
			} catch {
				// best-effort: the marker stays and is re-reconciled on next start
			}
		}
	}

	// ------------------------------------------------------------- persistence

	/**
	 * Persist workspace history without taking lifecycle ownership.
	 */
	setRunHistory(agentId: string, run: RunHistory): void {
		const child = this.mustGet(agentId);
		this.runHistories.set(agentId, structuredClone(run));
		if (child.settled) {
			const facts = child.terminalFacts();
			if (facts) this.writeResult(facts);
		} else {
			this.writeMarker(child.markerFacts());
		}
	}

	private writeResult(facts: ChildResultFacts): void {
		const result = this.toAgentResult(facts);
		// Persisted results record a post-settlement kill (cancel/retire of an
		// already-terminal record); the in-memory result() shape is unchanged.
		if (facts.processKilledAt !== undefined) result.processKilledAt = facts.processKilledAt;
		try {
			saveResult(result, this.resultsDir);
		} catch {
			// Persistence is best-effort; the in-memory record still serves results.
		}
	}

	/**
	 * Spawn-time partial marker (F003 reconciliation): a minimal "running"
	 * record written at process creation. Superseded in place by the terminal
	 * write at settle, or finalized as failed by startup reconciliation when
	 * the parent died before the child settled. Best-effort: a missing
	 * marker only weakens cross-restart reconciliation.
	 */
	private writeMarker(facts: ChildMarkerFacts): void {
		const run = this.persistedRun(facts.id);
		const marker: AgentResult = {
			id: facts.id,
			label: facts.label,
			task: facts.task,
			cwd: facts.cwd,
			status: "running",
			startedAt: facts.startedAt,
			...(facts.pid !== undefined ? { pid: facts.pid } : {}),
			...(facts.lastAssistantText !== undefined
				? { lastAssistantText: { ...facts.lastAssistantText } }
				: {}),
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
			...(run ? { run } : {}),
		};
		try {
			saveResult(marker, this.resultsDir);
		} catch {
			// best-effort by design
		}
	}

	private toAgentResult(facts: ChildResultFacts): AgentResult {
		const run = this.persistedRun(facts.id);
		return {
			id: facts.id,
			label: facts.label,
			task: facts.task,
			cwd: facts.cwd,
			status: facts.status,
			finalText: facts.finalText,
			summary: summarizeText(facts.finalText),
			failureReason: facts.failureReason,
			sessionFile: facts.sessionFile,
			sessionId: facts.sessionId,
			model: facts.model,
			startedAt: facts.startedAt,
			endedAt: facts.endedAt,
			tokens: facts.tokens,
			exitCode: facts.exitCode,
			signal: facts.signal,
			...(facts.lastAssistantText !== undefined
				? { lastAssistantText: { ...facts.lastAssistantText } }
				: {}),
			...(this.parentSession ? { parentSession: this.parentSession } : {}),
			...(run ? { run } : {}),
		};
	}

	/** Run history with freshly loaded progress overlaid (never executed here). */
	private persistedRun(agentId: string): RunHistory | undefined {
		const run = this.runHistories.get(agentId);
		if (!run) return undefined;
		const progress = loadProgress(agentId, this.resultsDir) ?? run.progress;
		return { ...run, ...(progress ? { progress } : {}) };
	}

	// ------------------------------------------------------------------ events

	onEvent(cb: (ev: SubagentModelEvent) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/**
	 * Subscribe to runtime-wide record mutations: spawn, logical state
	 * transitions (including waiting_input and its resolution), terminal
	 * settlement, process exit, cancel/retire, and shutdown. Subscribers
	 * recompute from `inspect()`; they must be cheap and must never throw
	 * (errors are swallowed so telemetry cannot break the runtime). Returns
	 * an unsubscribe function.
	 */
	onRecordsChanged(cb: () => void): () => void {
		this.recordsListeners.add(cb);
		return () => this.recordsListeners.delete(cb);
	}

	private notifyRecordsChanged(): void {
		for (const cb of this.recordsListeners) {
			try {
				cb();
			} catch {
				// listener errors must not break the runtime
			}
		}
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
		return this.children.get(agentId)?.eventRoute === "workspace";
	}

	/**
	 * Event router for one child. A workspace-routed child's lifecycle events
	 * belong to the workspace run registry — waiters and generic listeners
	 * never see them (the terminal surface is the shared [subagent completed]
	 * event). For generic children a waiter gets the event first (consumed);
	 * otherwise it goes to background delivery. `background: false` events
	 * (cancel confirmations) resolve waiters only — the cancelling side already
	 * learned the outcome synchronously, and a duplicate steer message would
	 * just burn a turn.
	 */
	private routeEvent(
		agentId: string,
		eventRoute: "workspace" | undefined,
		ev: SubagentModelEvent,
		opts?: { background?: boolean },
	): void {
		if (eventRoute === "workspace") {
			for (const cb of this.workspaceListeners) {
				try {
					cb(ev);
				} catch {
					// listener errors must not break the runtime
				}
			}
			return;
		}
		const outcome = eventToOutcome(ev);
		const waiting = this.waiters.get(agentId);
		if (waiting && waiting.length > 0) {
			this.waiters.delete(agentId);
			for (const waiter of waiting) waiter(outcome);
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

	private mustGet(agentId: string): ChildAgentProcess {
		const child = this.children.get(agentId);
		if (!child) throw new Error(`unknown agent id: ${agentId}`);
		return child;
	}

	// ------------------------------------------------------------------- cost

	/**
	 * Session subagent cost total: results already on disk for this session
	 * (resume base) plus the latest cumulative cost reported by every agent
	 * of the live runtime. Children settled in this runtime are counted from
	 * memory only — their results were written after the base was computed.
	 */
	private recordCost(agentId: string, cost: number): void {
		this.countedCost.set(agentId, cost);
		this.notifyCostChange();
	}

	private notifyCostChange(): void {
		if (!this.onCostChange) return;
		let total = this.persistedBaseCost;
		for (const cost of this.countedCost.values()) total += cost;
		this.onCostChange(total);
	}

	// --------------------------------------------------------------- shutdown

	/** Kill all live children without latching the runtime shut. */
	async cancelAll(): Promise<void> {
		const live = [...this.children.values()].filter((c) => c.alive);
		if (live.length === 0) return;
		await Promise.all(live.map((c) => c.cancel()));
		this.notifyRecordsChanged();
	}

	/** Kill all live children and latch the runtime shut (main shutdown). */
	async shutdown(): Promise<void> {
		this.shutDown = true;
		await this.cancelAll();
		this.notifyRecordsChanged();
	}
}

// -------------------------------------------------------------------- helpers

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

/**
 * Parse the results dir for spawn-time "running" markers (F003): entries
 * whose status is not terminal yet. Unreadable or corrupt files are skipped;
 * the parsed result rides along for callers that rewrite it in place.
 */
function runningMarkers(dir: string): AgentResult[] {
	return listAllResults(dir).filter((r) => typeof r.id === "string" && r.status === "running");
}

function isTerminalStatus(status: AgentResult["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
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
