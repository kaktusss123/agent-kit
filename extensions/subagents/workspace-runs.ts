/**
 * Workspace runs — the RepoOwner contract for `subagent` spawns that own a
 * managed task worktree.
 *
 * Workspace is a MODE of a `subagent` spawn, not a separate agent kind: the
 * same LocalSubagentRuntime owns every child process; this module adds the
 * RepoOwner policy surface for spawns created with `workspace=<path>`.
 * RepoOwner children are spawned with a per-spawn profile (task-workspace
 * binding + reporting bridge + readiness probe), their lifecycle events are
 * routed here by the controller's event router (`eventRoute: "workspace"`),
 * and generic subagent surfaces stay untouched.
 *
 * Contract:
 * - fail closed before dispatch (model pinning to the main session, workspace
 *   validation, static preflight, readiness handshake — the task prompt never
 *   reaches a model before the child proves initialization);
 * - no fallback after dispatch (abort = detach; repair = a new owner spawn);
 * - deadline covers the whole run including the report ladder;
 * - settlement accepts only a fresh report_result envelope (staleness is
 *   enforced by the reporting bridge); terminal outcomes retire the child
 *   while preserving its record;
 * - settled-state verification (ADR-0003): a `done` product outcome is
 *   accepted only when the worktree reads back settled after the child
 *   stopped (accessible repository, current HEAD, clean tree); otherwise
 *   the outcome downgrades to blocked with a done_rejected reason, and
 *   every terminal result carries objective Git facts read by the runtime;
 * - every run is identified by its agentId (the subagent id); state and the
 *   terminal outcome stay queryable through `subagent` op=status/result for
 *   the rest of the main session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	envelopeFileName,
	validateEnvelopeRecord,
	type Envelope,
	type EnvelopeRecord,
} from "./envelope";
import { PROFILE_READINESS } from "./readiness";
import {
	expandPath,
	getRepoBranch,
	git,
	isLinkedWorktree,
	parseDirtyStatus,
	realpath,
} from "../task-workspace/git";
import type { DirtyState } from "../task-workspace/types";
import { resolveTaskRoot } from "../task-workspace/task-root";
import { formatRunStatus, type RunStatusView } from "./activity";
import { formatNeedsInputBody } from "./delivery";
import type { AgentSnapshot, SubagentModelEvent } from "./types";
import type { LocalSubagentRuntime } from "./controller";
import type { AskInput } from "../ask/contract";

// ============================================================ configuration

/** Report ladder depth: at most this many follow-ups before `blocked`. */
const LADDER_MAX = 3;

const DEFAULT_DEADLINE_MS = 600000;

/** Live status refresh cadence: modest — a few seconds, not a spinner. */
const STATUS_REFRESH_MS = 3000;

// ================================================================ run model

export type ExternalStatus =
	| "done"
	| "partial"
	| "blocked"
	| "unsupported"
	| "needs_input"
	| "error"
	| "running";

/**
 * Objective Git facts of the workspace, read mechanically by the runtime
 * (ADR-0002 §10) — never model-reported. `branch` is empty on detached HEAD.
 */
export interface GitFacts {
	branch: string;
	headSha: string;
	dirty: DirtyState;
}

interface TerminalOutcome {
	status: "done" | "partial" | "blocked";
	reason?: string;
	result?: Envelope;
	lastOutput?: string;
	childMayHaveMutatedRepo: boolean;
	gitFacts?: GitFacts;
}

interface WorkspaceAgentRun {
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
	/** Live tool-progress refresh loop (operator observability); dead on terminal/needs_input/detach. */
	statusTimer?: NodeJS.Timeout;
	waiters: Array<(outcome: "settled" | "needs_input" | "detached") => void>;
}

/** Protocol outcome of a workspace run, as returned by spawn and op=result. */
export interface WorkspaceRunOutcome {
	status: ExternalStatus;
	dispatched: boolean;
	workspace: string;
	agentId?: string;
	state?: string;
	question?: string;
	/** Structured canonical ask request when status is needs_input. */
	request?: AskInput;
	deadlineMsLeft?: number;
	result?: Envelope;
	last_output?: string;
	reason?: string;
	child_may_have_mutated_repo?: boolean;
	/** Runtime-read Git facts of the workspace at settlement (undefined when Git could not be read at all). */
	git_facts?: GitFacts;
}

/** Point-in-time view of a workspace run for op=status / op=result. */
export interface WorkspaceRunView {
	/** Set when the run reached a terminal outcome; still queryable afterwards. */
	terminal?: WorkspaceRunOutcome;
	state: string;
	workspace: string;
	deadlineMsLeft: number;
	ladder?: { step: number; max: number };
	question?: string;
	/** Structured canonical ask request while the run waits for input. */
	request?: AskInput;
}

/**
 * Cross-tool allow-list for RepoOwner children on the `subagent` tool.
 * status/result/respond/cancel stay available to Main. The workspace spawn
 * call owns the run's outcome (wait would steal lifecycle events that belong
 * to this registry); steer/follow_up would bypass the run's deadline and
 * task contract.
 */
export function managedAgentOpPolicy(op: string): { allowed: boolean; reason?: string } {
	switch (op) {
		case "wait":
			return {
				allowed: false,
				reason:
					"wait is not allowed for workspace runs (workspace-owned agent): the workspace spawn call owns the run outcome — use op=status / op=result",
			};
		case "steer":
		case "follow_up":
			return {
				allowed: false,
				reason: `${op} is not allowed for workspace runs (workspace-owned agent): it would bypass the run's deadline and task contract`,
			};
		default:
			return { allowed: true };
	}
}

/**
 * Pi's tool progress channel: partial, display-only updates rendered in
 * place on the tool call. Never enters Main's LLM context; calls after the
 * tool promise settles are ignored by pi.
 */
export type ToolUpdateCallback = (update: {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}) => void;

/** Arguments of a workspace-mode `subagent` spawn. */
export interface WorkspaceSpawnArgs {
	workspace: string;
	task: string;
	/** Run deadline in seconds (covers the whole run including the report ladder). */
	deadlineSec?: number;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateCallback;
	/** Main session model; the child inherits it (no modelClass in workspace mode). */
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	cwd?: string;
}

/** Tool-shaped result of a workspace spawn (JSON content + structured details). */
export interface WorkspaceToolResult {
	content: [{ type: "text"; text: string }];
	details: WorkspaceRunOutcome | Record<string, unknown>;
	isError?: boolean;
}

// ==================================================================== layer

export interface WorkspaceRunsOptions {
	/** Override the profile entrypoint paths (tests: point at missing files). */
	profileEntries?: () => string[];
	/** Live status refresh interval override (tests: fast cadence). */
	statusRefreshMs?: number;
}

/** RepoOwner policy surface for workspace-mode subagent spawns. */
export interface WorkspaceRuns {
	/** Validate, spawn, and (unless aborted) block until terminal/needs_input. */
	spawnRun(args: WorkspaceSpawnArgs): Promise<WorkspaceToolResult>;
	/** Current view of a run (undefined when the agent is not workspace-owned). */
	runView(agentId: string): WorkspaceRunView | undefined;
	/** True when the agent id belongs to a workspace-routed RepoOwner. */
	isManaged(agentId: string): boolean;
}

export function createWorkspaceRuns(
	pi: ExtensionAPI,
	getRuntime: (ctxCwd: string | undefined) => LocalSubagentRuntime,
	opts?: WorkspaceRunsOptions,
): WorkspaceRuns {
	const runsByAgentId = new Map<string, WorkspaceAgentRun>();

	// The runtime is created lazily by the host, but children can only exist
	// after the layer acquired it. Once acquired, bind it and subscribe the
	// single event-ownership handler exactly once.
	let boundRt: LocalSubagentRuntime | undefined;
	const R = (ctxCwd: string | undefined): LocalSubagentRuntime => {
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

	// Task-root policy lives in the task subsystem
	// (../task-workspace/task-root): AGENT_TASK_ROOT override, then the
	// ~/.agent-kit/tasks default. This layer never computes a filesystem
	// layout itself.
	const taskRoot = resolveTaskRoot();
	const statusRefreshMs = opts?.statusRefreshMs ?? STATUS_REFRESH_MS;

	/** The bound runtime (events and settlement only run after a dispatch bound it). */
	const rt = (): LocalSubagentRuntime => {
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
				await finish(run, {
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
			// the settled child is actually gone — which is also what keeps
			// the settled-state check below free of concurrent mutation.
			await retireChild(run);
			if (record.envelope.status === "done") {
				// Settled-state verification (ADR-0003): a done outcome is
				// accepted only when Git reads the worktree as settled —
				// accessible repository, current HEAD, clean tree. Read after
				// the child stopped, so it cannot mutate during the check.
				const state = await readGitState(run.workspace);
				if (!state.ok) {
					await finish(run, {
						status: "blocked",
						reason: state.facts
							? `done_rejected_dirty_worktree: ${formatDirty(state.facts.dirty)}`
							: `done_rejected_unreadable_git_state: ${state.problem}`,
						lastOutput: await lastOutput(run.agentId),
						childMayHaveMutatedRepo: true,
						gitFacts: state.facts,
					});
					return;
				}
				await finish(run, {
					status: "done",
					result: record.envelope,
					childMayHaveMutatedRepo: false,
					gitFacts: state.facts,
				});
				return;
			}
			// partial/blocked product outcomes exist to report unfinished work:
			// no clean-tree requirement; facts are attached by finish().
			await finish(run, {
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
					await finish(run, {
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
				await finish(run, {
					status: "partial",
					reason: "deadline",
					lastOutput: last,
					childMayHaveMutatedRepo: true,
				});
			} else {
				await retireChild(run);
				await finish(run, {
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
		await finish(run, {
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

	async function finish(run: WorkspaceAgentRun, outcome: TerminalOutcome): Promise<void> {
		if (run.terminal) return;
		// Claim the outcome BEFORE any await: a concurrent terminal event
		// (cancel racing a settle) must observe `terminal` and back off. The
		// Git-facts fetch between claim and resolution only refines the record.
		run.terminal = outcome;
		// Objective Git facts (ADR-0002 §10): runtime-read, never model-
		// reported. The fresh-envelope settle path passes them explicitly
		// (it needs the verdict anyway); every other terminal outcome gets
		// a best-effort read here. A failed read leaves them undefined.
		outcome.gitFacts = outcome.gitFacts ?? (await readGitFacts(run.workspace));
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
			`[subagent needs input] ${run.agentId} — workspace run`,
			`agentId: ${run.agentId}`,
			`workspace: ${run.workspace}`,
			...formatNeedsInputBody(run.question ?? "(unknown)", run.request),
			`answer via subagent op=respond id=${run.agentId} answer=<...>; the run resumes under the same deadline`,
			`details via subagent op=result id=${run.agentId}`,
		];
		try {
			pi.sendMessage(
				{
					customType: "subagent-event",
					content: lines.join("\n"),
					display: true,
					details: { agentId: run.agentId, kind: "needs_input", workspace: true },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// op=status/result remain the recovery path if delivery fails.
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
		// The outer status is the DELIVERY outcome ("done" = the child settled
		// and reported); the product status lives only in envelope.status. When
		// they diverge, the status line must say so or the compact event would
		// advertise a partial/blocked product as a plain "done".
		const reportStatus = o.result && o.result.status !== o.status ? ` (report: ${o.result.status})` : "";
		const statusLabel = `${o.status}${reportStatus}`;
		const lines = [
			`[subagent completed] ${run.agentId} — workspace run`,
			`workspace: ${run.workspace}`,
		];
		if (o.gitFacts) {
			lines.push(
				`${statusLabel} · ${o.gitFacts.branch || "(detached)"} @ ${o.gitFacts.headSha.slice(0, 7)} · ${formatDirty(o.gitFacts.dirty)}`,
			);
		} else {
			lines.push(statusLabel);
		}
		// Compact delivery (see delivery.ts): the summary IS the report; the
		// full envelope stays persisted, reachable via op=result below.
		const env = o.result;
		if (env) {
			lines.push(`summary: ${env.summary}`);
			const total = env.verification.length;
			const passed = env.verification.filter((c) => c.result === "pass").length;
			let metrics = `${total > 0 && passed === total ? "✓" : "✗"} ${passed}/${total} checks`;
			if (env.changed_scope.length > 0) {
				metrics += ` · scope: ${env.changed_scope.slice(0, 2).join(", ")}`;
				if (env.changed_scope.length > 2) metrics += ` +${env.changed_scope.length - 2} more`;
			}
			lines.push(metrics);
			if (env.gaps.length > 0) lines.push(`gaps: ${env.gaps.join("; ")}`);
			if (env.contract_conflicts && env.contract_conflicts.length > 0) {
				lines.push(`contract conflicts: ${env.contract_conflicts.join("; ")}`);
			}
		}
		if (o.reason) lines.push(`reason: ${o.reason}`);
		if (o.childMayHaveMutatedRepo) lines.push(`child_may_have_mutated_repo: true`);
		lines.push(`details via subagent op=result id=${run.agentId}`);
		try {
			pi.sendMessage(
				{
					customType: "subagent-event",
					content: lines.join("\n"),
					display: true,
					details: { agentId: run.agentId, kind: "completed", status: o.status, workspace: true },
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

	/**
	 * Live operator observability: while Main stays blocked inside this tool
	 * call, periodically render a truthful snapshot of the run (identity,
	 * state, elapsed/deadline, session, current + recent child activity) into
	 * the tool call via Pi's transient onUpdate channel. No context
	 * propagation — the child transcript stays isolated; this is progress UI.
	 */
	function startLiveStatus(run: WorkspaceAgentRun, onUpdate: ToolUpdateCallback | undefined): void {
		if (!onUpdate) return; // no progress channel (e.g. bare execute callers)
		emitStatus(run, onUpdate);
		const timer = setInterval(() => emitStatus(run, onUpdate), statusRefreshMs);
		timer.unref?.();
		run.statusTimer = timer;
	}

	function stopLiveStatus(run: WorkspaceAgentRun): void {
		if (run.statusTimer) {
			clearInterval(run.statusTimer);
			run.statusTimer = undefined;
		}
	}

	function emitStatus(run: WorkspaceAgentRun, onUpdate: ToolUpdateCallback): void {
		try {
			const snap = rt().inspect(run.agentId)[0];
			if (!snap) return;
			onUpdate({ content: [{ type: "text" as const, text: formatRunStatus(buildStatusView(run, snap)) }] });
		} catch {
			// Rendering must never break the run.
		}
	}

	function buildStatusView(run: WorkspaceAgentRun, snap: AgentSnapshot): RunStatusView {
		const now = Date.now();
		return {
			agentId: run.agentId,
			workspace: run.workspace,
			state: run.state,
			...(run.ladder > 0 ? { ladder: { step: run.ladder, max: LADDER_MAX } } : {}),
			elapsedMs: now - run.startedAt,
			deadlineMsLeft: Math.max(0, run.deadline - now),
			pid: snap.pid,
			model: snap.model,
			thinking: snap.thinking,
			stats: snap.stats,
			sessionId: snap.sessionId,
			sessionFile: snap.sessionFile,
			activeTool: snap.activeTool,
			recentActivity: snap.recentActivity,
			now,
		};
	}

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
				await finish(run, {
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

	// -------------------------------------------------------- spawn (dispatch)

	async function spawnRun(args: WorkspaceSpawnArgs): Promise<WorkspaceToolResult> {
		const { workspace, task, signal, onUpdate } = args;
		const deadlineMs = Math.max(1000, (args.deadlineSec ?? DEFAULT_DEADLINE_MS / 1000) * 1000);
		// Pre-dispatch gate 1: model pinning — no silent defaults. Workspace
		// children inherit the main session model (modelClass does not apply).
		if (!args.model) {
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
			snap = await R(args.cwd).spawn({
				task,
				label: `owner-${base}`,
				cwd: realWorkspace,
				model: `${args.model.provider}/${args.model.id}`,
				thinking: args.thinkingLevel,
				additionalExtensions: profileEntries(),
				readinessEntries: PROFILE_READINESS,
				eventRoute: "workspace",
				signal,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// An abort before the task prompt was accepted means no process
			// and no task — blocked, dispatched:false. (If acceptance won the
			// race, spawn resolved and the signal's ownership moved to the
			// detach wait below.)
			if (message.includes("aborted before dispatch")) {
				return fail("blocked", workspace, message);
			}
			// Pre-dispatch startup failures are classified: a broken/missing
			// extension, a dead child, or a rejected/timed-out prompt all mean
			// "this profile cannot run here" → unsupported, the Main-side
			// fallback signal. Only genuinely unclassified wrapper failures
			// surface as error.
			const startupFailure =
				message.includes("readiness handshake") ||
				message.includes("exited before accepting") ||
				message.includes("spawn error") ||
				message.includes("did not accept the initial prompt") ||
				message.includes("initial prompt rejected") ||
				message.includes("child failed to start");
			return fail(startupFailure ? "unsupported" : "error", workspace, message);
		}

		const run: WorkspaceAgentRun = {
			agentId: snap.id,
			workspace: realWorkspace,
			task,
			deadline: Date.now() + deadlineMs,
			startedAt: Date.now(),
			state: "running",
			ladder: 0,
			lastSeenGeneration: 0,
			deadlineFired: false,
			waiters: [],
		};
		runsByAgentId.set(snap.id, run);
		armDeadline(run);
		startLiveStatus(run, onUpdate);

		// Blocking wait: terminal or needs_input. Abort = detach (the run
		// keeps going; completion arrives as an event / via op=status|result).
		try {
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
					state: run.state,
					deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
					...(run.terminal
						? {}
						: { reason: "detached by main abort; the run continues under its deadline — completion arrives as a [subagent completed] event or via subagent op=result" }),
				});
			}
			return ok(runOutcome(run));
		} finally {
			// The progress loop dies on EVERY exit: terminal, needs_input,
			// detach, and thrown errors. No leaked timers, no updates after the
			// tool call settled.
			stopLiveStatus(run);
		}
	}

	// ----------------------------------------------------------------- query

	function runOutcome(run: WorkspaceAgentRun): WorkspaceRunOutcome {
		const base: WorkspaceRunOutcome = {
			status: "blocked",
			dispatched: true,
			workspace: run.workspace,
			agentId: run.agentId,
		};
		if (run.terminal) {
			return {
				...base,
				status: run.terminal.status,
				result: run.terminal.result,
				reason: run.terminal.reason,
				last_output: run.terminal.lastOutput,
				child_may_have_mutated_repo: run.terminal.childMayHaveMutatedRepo,
				...(run.terminal.gitFacts ? { git_facts: run.terminal.gitFacts } : {}),
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
		// spawn (which resolves only on terminal/needs_input), so the shared
		// orchestration rule "partial/blocked means inspect + repair" cannot
		// be triggered by a merely running owner.
		return {
			...base,
			status: "running",
			state: run.state,
			deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
		};
	}

	function runView(agentId: string): WorkspaceRunView | undefined {
		const run = runsByAgentId.get(agentId);
		if (!run) return undefined;
		const outcome = runOutcome(run);
		return {
			...(run.terminal ? { terminal: outcome } : {}),
			...(outcome.status === "needs_input" ? { question: run.question, request: run.request } : {}),
			state: run.terminal ? "settled" : run.state,
			workspace: run.workspace,
			deadlineMsLeft: Math.max(0, run.deadline - Date.now()),
			...(run.ladder > 0 ? { ladder: { step: run.ladder, max: LADDER_MAX } } : {}),
		};
	}

	// --------------------------------------------------------------- helpers

	function fail(status: "blocked" | "unsupported" | "error", workspace: string, reason: string): WorkspaceToolResult {
		return ok({ status, dispatched: false, workspace, reason });
	}

	function ok(result: WorkspaceRunOutcome): WorkspaceToolResult {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: result,
		};
	}

	return {
		spawnRun,
		runView,
		isManaged: (agentId: string) => runsByAgentId.has(agentId),
	};
}

// -------------------------------------------------------------------- helpers

/**
 * Objective state of the workspace, read mechanically from Git.
 * The three settled-state checks for a `done` product outcome:
 * accessible git repository, current HEAD, clean working tree
 * (untracked non-ignored files count as dirt; ignored files — build
 * output, caches — do not). `facts` is present whenever Git could read
 * at least status, so even a rejected done carries what Main needs.
 */
type GitState = { ok: true; facts: GitFacts } | { ok: false; problem: string; facts?: GitFacts };

async function readGitState(workspace: string): Promise<GitState> {
	try {
		const toplevel = await git(workspace, "rev-parse", "--show-toplevel");
		if (!toplevel.ok) {
			return {
				ok: false,
				problem: `not an accessible git repository (${toplevel.stderr || "git rev-parse --show-toplevel failed"})`,
			};
		}
		const head = await git(workspace, "rev-parse", "HEAD");
		if (!head.ok) {
			return { ok: false, problem: `no current HEAD (${head.stderr || "git rev-parse HEAD failed"})` };
		}
		const status = await git(workspace, "status", "--porcelain=v2", "--no-renames");
		if (!status.ok) {
			return { ok: false, problem: `git status failed (${status.stderr || "no output"})` };
		}
		const facts: GitFacts = {
			branch: await getRepoBranch(workspace),
			headSha: head.stdout,
			dirty: parseDirtyStatus(status.stdout),
		};
		if (facts.dirty.staged.length > 0 || facts.dirty.unstaged.length > 0) {
			return { ok: false, problem: `working tree is not clean (${formatDirty(facts.dirty)})`, facts };
		}
		return { ok: true, facts };
	} catch (e) {
		// git missing or unspawnable: fail closed, never silently "clean"
		return { ok: false, problem: `git state unreadable: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** Best-effort facts for terminal outcomes that carry no acceptance verdict. */
async function readGitFacts(workspace: string): Promise<GitFacts | undefined> {
	return (await readGitState(workspace)).facts;
}

/** Bounded human summary of the dirty state (reason lines, notifications). */
function formatDirty(dirty: DirtyState): string {
	const parts: string[] = [];
	if (dirty.staged.length > 0) parts.push(`staged: ${dirty.staged.join(", ")}`);
	if (dirty.unstaged.length > 0) parts.push(`unstaged: ${dirty.unstaged.join(", ")}`);
	return parts.join("; ") || "clean";
}

/**
 * Additional-extension load order for the RepoOwner profile. ORDER MATTERS:
 * the reporting bridge must come BEFORE task-workspace so its tool_call
 * staleness hook runs first — pi dispatches tool_call handlers in extension
 * order and stops at the first block, so a blocked call (e.g. the mutation
 * guard refusing a raw no-verify commit) must already have invalidated the
 * previous report_result envelope. The subagents index follows: it registers
 * the plain `subagent` tool (nested repo-local helpers, modelClass applies)
 * and owns no tool_call hooks, so it does not perturb the guard order. The
 * readiness probe comes LAST as a pure observer (no tools, no tool_call
 * hooks): its session_start handler fires after all factories have run
 * anyway, and its position must not perturb the capability entries' handler
 * order.
 */
export function defaultProfileEntries(moduleDir: string): string[] {
	return [
		path.join(moduleDir, "reporting-bridge.ts"),
		path.join(moduleDir, "..", "task-workspace", "index.ts"),
		path.join(moduleDir, "index.ts"),
		path.join(moduleDir, "readiness-probe.ts"),
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
