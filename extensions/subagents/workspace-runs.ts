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
 * - fail closed before dispatch (model resolution through the shared spawn
 *   boundary, workspace validation, static preflight, readiness handshake —
 *   the task prompt never reaches a model before the child proves
 *   initialization);
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
import type { ModelLike, ModelPair, ThinkingLevel } from "./model-spec";
import { resolveSpawnPair } from "./spawn-model";
import {
	envelopeFileName,
	validateEnvelopeRecord,
	type Envelope,
	type EnvelopeRecord,
} from "./envelope";
import { PROFILE_READINESS } from "./readiness";
import { ProviderExtensionError } from "./provider-extensions";
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
import { markOwnDelivery, ownDeliveryInFlight } from "./steering-wake";
import type { AgentSnapshot, SubagentModelEvent } from "./types";
import type { LocalSubagentRuntime } from "./controller";
import type { AskInput } from "../ask/contract";
import { loadProgress, type Progress, type RunHistory } from "./progress";

// ============================================================ configuration

/** Report ladder depth: at most this many follow-ups before `blocked`. */
const LADDER_MAX = 3;

const DEFAULT_DEADLINE_MS = 600000;
const DEFAULT_WAIT_MS = 600000;
const MIN_FINALIZATION_RESERVE_MS = 30000;

/** Live status refresh cadence: modest — a few seconds, not a spinner. */
const STATUS_REFRESH_MS = 3000;

/** Steering wake poll cadence: a user message should detach within ~half a second. */
const STEERING_WAKE_POLL_MS = 450;

/** Reason returned when a pending user message detached the blocking spawn call. */
const STEERING_WAKE_REASON =
	"detached because the user sent a message while Main was waiting; the run continues under its deadline — " +
	"completion arrives as a [subagent completed] event or via subagent op=result; handle the user's message now; " +
	"use subagent op=cancel if the user asked to stop";

/** Reason returned when the main abort detached the blocking spawn call. */
const ABORT_DETACH_REASON =
	"detached by main abort; the run continues under its deadline — " +
	"completion arrives as a [subagent completed] event or via subagent op=result";

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
	/** Only one settlement may fetch Git facts/publish/release ownership. */
	finishing?: Promise<void>;
	reservation: symbol;
	progress?: Progress;
	waiters: Array<() => void>;
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
	deadlineAt?: number;
	progress?: Progress;
	progressAgeMs?: number;
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
	deadlineAt?: number;
	progress?: Progress;
	progressAgeMs?: number;
	ladder?: { step: number; max: number };
	question?: string;
	/** Structured canonical ask request while the run waits for input. */
	request?: AskInput;
}

/**
 * Cross-tool allow-list for RepoOwner children on the `subagent` tool.
 * Main waits through this registry, never the controller's generic waiter.
 * Safe steering queues into the active run. follow_up is forbidden: it could
 * restart an owner outside its deadline and task contract.
 */
export function managedAgentOpPolicy(op: string): { allowed: boolean; reason?: string } {
	switch (op) {
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
	/** Continuous Main wait cap; independent of the absolute run deadline. */
	waitTimeoutSec?: number;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateCallback;
	/**
	 * Explicit model (`provider/id[:thinking]`), valid for workspace spawns
	 * exactly like plain spawns. Mutually exclusive with `role`.
	 */
	model?: string;
	/**
	 * Role under which the child runs: always `owner` for workspace spawns
	 * (omitted or `owner`); its binding in subagent-roles.json decides the
	 * model, else the session pair.
	 */
	role?: string;
	/** Live session model: the inheritance source and the no-model gate fact. */
	sessionModel?: { provider: string; id: string };
	/** Registry-backed model catalogue for validating stored class pairs. */
	modelRegistry?: { getAll(): ModelLike[] };
	/** Live session thinking level (inheritance source). */
	thinkingLevel?: string;
	cwd?: string;
	/**
	 * Pending-message probe of the main session (pi ExtensionContext).
	 * While the blocking wait is in progress, a truthy probe detaches the call
	 * with the steering-wake reason so Main handles the queued user message;
	 * the run continues under its deadline. Own deliveries are suppressed via
	 * ./steering-wake. Never consulted before dispatch acceptance.
	 */
	hasPendingMessages?: () => boolean;
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
	/** Steering wake poll interval override (tests: fast cadence). */
	steeringWakePollMs?: number;
	/** Deterministic settlement test seam; production always reads real Git. */
	readGitState?: (workspace: string) => Promise<GitState>;
}

/** RepoOwner policy surface for workspace-mode subagent spawns. */
export interface WorkspaceRuns {
	/** Validate, reserve, spawn, and block until terminal/needs_input or the independent wait cap. */
	spawnRun(args: WorkspaceSpawnArgs): Promise<WorkspaceToolResult>;
	waitRun(agentId: string, args?: WorkspaceWaitArgs): Promise<WorkspaceToolResult>;
	steerRun(agentId: string, message: string): Promise<void>;
	cancelRun(agentId: string): Promise<void>;
	/** Current view of a run (undefined when the agent is not workspace-owned). */
	runView(agentId: string): WorkspaceRunView | undefined;
	/** True when the agent id belongs to a workspace-routed RepoOwner. */
	isManaged(agentId: string): boolean;
}

export interface WorkspaceWaitArgs {
	timeoutSec?: number;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateCallback;
	hasPendingMessages?: () => boolean;
}

export function createWorkspaceRuns(
	pi: ExtensionAPI,
	getRuntime: (ctxCwd: string | undefined) => LocalSubagentRuntime,
	opts?: WorkspaceRunsOptions,
): WorkspaceRuns {
	const runsByAgentId = new Map<string, WorkspaceAgentRun>();
	// Reserved synchronously before dispatch, retained through stop and Git reads.
	const reservations = new Map<string, symbol>();
	// A fast child may emit lifecycle before prompt acceptance is acknowledged.
	// Buffer only known dispatching identities, bounded and discarded on refusal.
	const dispatchEvents = new Map<string, SubagentModelEvent[]>();
	const gitState = opts?.readGitState ?? readGitState;

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
					void handleEvent(ev).catch(() => { /* query remains the recovery path */ });
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
	const steeringWakePollMs = opts?.steeringWakePollMs ?? STEERING_WAKE_POLL_MS;

	/** The bound runtime (events and settlement only run after a dispatch bound it). */
	const rt = (): LocalSubagentRuntime => {
		if (!boundRt) return R(undefined);
		return boundRt;
	};

	// ---------------------------------------------------------------- events

	async function handleEvent(ev: SubagentModelEvent): Promise<void> {
		const run = runsByAgentId.get(ev.agentId);
		if (!run) {
			const pending = dispatchEvents.get(ev.agentId);
			if (pending) { pending.push(ev); if (pending.length > 16) pending.shift(); }
			return;
		}
		if (run.terminal || run.deadlineFired) return;
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
					resolveWaiters(run);
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
				if (!claimTermination(run)) return;
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
		if (run.terminal || run.deadlineFired || run.state === "settling") return;
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
			if (!claimTermination(run)) return;
			// Terminal lifecycle (F4): the completion is published only after
			// the settled child is actually gone — which is also what keeps
			// the settled-state check below free of concurrent mutation.
			await retireChild(run);
			if (record.envelope.status === "done") {
				// Settled-state verification (ADR-0003): a done outcome is
				// accepted only when Git reads the worktree as settled —
				// accessible repository, current HEAD, clean tree. Read after
				// the child stopped, so it cannot mutate during the check.
				const state = await gitState(run.workspace);
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
				if (claimTermination(run)) {
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
		if (!claimTermination(run)) return;
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

	function claimTermination(run: WorkspaceAgentRun): boolean {
		if (run.terminal || run.deadlineFired) return false;
		run.deadlineFired = true;
		run.state = "terminating";
		run.question = undefined;
		run.request = undefined;
		if (run.deadlineTimer) clearTimeout(run.deadlineTimer);
		return true;
	}

	async function finish(run: WorkspaceAgentRun, outcome: TerminalOutcome): Promise<void> {
		if (run.terminal) return;
		if (run.finishing) return run.finishing;
		run.finishing = (async () => {
			// No terminal projection, waiter resolution or ownership release until
			// the child is stopped AND the entire Git read has finished.
			outcome.gitFacts = outcome.gitFacts ?? (await gitState(run.workspace)).facts;
			run.terminal = outcome;
			persistHistory(run);
			if (reservations.get(run.workspace) === run.reservation) reservations.delete(run.workspace);
			resolveWaiters(run);
			notifyCompleted(run);
		})();
		return run.finishing;
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
			// Own delivery: open the suppression window BEFORE enqueueing so a
			// concurrently polling steering wake never mistakes this message
			// for user input (see ./steering-wake).
			markOwnDelivery();
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
			// Own delivery: open the suppression window BEFORE enqueueing so a
			// concurrently polling steering wake never mistakes this message
			// for user input (see ./steering-wake).
			markOwnDelivery();
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

	function resolveWaiters(run: WorkspaceAgentRun): void {
		for (const w of run.waiters.splice(0)) w();
	}

	// -------------------------------------------------------------- deadline

	/**
	 * Live operator observability: while Main stays blocked inside this tool
	 * call, periodically render a truthful snapshot of the run (identity,
	 * state, elapsed/deadline, session, current + recent child activity) into
	 * the tool call via Pi's transient onUpdate channel. No context
	 * propagation — the child transcript stays isolated; this is progress UI.
	 */
	function startLiveStatus(run: WorkspaceAgentRun, onUpdate: ToolUpdateCallback | undefined): () => void {
		if (!onUpdate) return () => {};
		emitStatus(run, onUpdate);
		const timer = setInterval(() => emitStatus(run, onUpdate), statusRefreshMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	function emitStatus(run: WorkspaceAgentRun, onUpdate: ToolUpdateCallback): void {
		try {
			const snap = rt().inspect(run.agentId)[0];
			if (!snap) return;
			onUpdate({
				content: [{ type: "text" as const, text: formatRunStatus(buildStatusView(run, snap)) }],
				details: { run: compactRunView(runView(run.agentId)!) },
			});
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
			progress: observations(run).progress,
			now,
		};
	}

	function armDeadline(run: WorkspaceAgentRun): void {
		const remaining = Math.max(0, run.deadline - Date.now());
		run.deadlineTimer = setTimeout(() => {
			if (!claimTermination(run)) return;
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
		const { workspace, task, signal, onUpdate, hasPendingMessages } = args;
		const deadlineMs = Math.max(1000, (args.deadlineSec ?? DEFAULT_DEADLINE_MS / 1000) * 1000);
		// Pre-dispatch gate 1: model resolution — no silent defaults. The child
		// runs on the explicit model, the owner role binding, or the live
		// session pair (resolved through the shared spawn boundary). Every
		// resolution failure — no session model, unknown model, a broken
		// binding, an invalid model/role combination — is a Main-side problem:
		// blocked, dispatched:false, nothing started.
		let pair: ModelPair;
		try {
			pair = resolveSpawnPair(
				"workspace",
				{ model: args.model, role: args.role },
				{ model: args.sessionModel, modelRegistry: args.modelRegistry ?? { getAll: () => [] } },
				(args.thinkingLevel as ThinkingLevel | undefined) ?? "off",
			);
		} catch (e) {
			return fail("blocked", workspace, e instanceof Error ? e.message : String(e));
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
		if (reservations.has(realWorkspace)) return fail("blocked", realWorkspace, "workspace already has an active or dispatching RepoOwner");
		const reservation = Symbol(realWorkspace);
		reservations.set(realWorkspace, reservation);
		const base = path.basename(realWorkspace);
		let createdId: string | undefined;
		let snap: AgentSnapshot;
		try {
			snap = await R(args.cwd).spawn({
				task,
				// Only the prompt sent to this child receives the runtime-owned
				// deadline instructions. Controller records keep `task` canonical.
				initialPrompt: repoOwnerPrompt(task, deadlineMs),
				label: `owner-${base}`,
				cwd: realWorkspace,
				model: pair.model,
				thinking: pair.thinking,
				additionalExtensions: profileEntries(),
				readinessEntries: PROFILE_READINESS,
				eventRoute: "workspace",
				signal,
				onCreated: (s) => { createdId = s.id; dispatchEvents.set(s.id, []); },
				onAccepted: (s) => {
					// Synchronous publication BEFORE the next child line: an ask or
					// completion in the same stdout chunk cannot escape the registry.
					const now = Date.now();
					const run: WorkspaceAgentRun = {
						agentId: s.id, workspace: realWorkspace, task,
						deadline: now + deadlineMs, startedAt: now, state: "running",
						ladder: 0, lastSeenGeneration: 0, deadlineFired: false,
						reservation, waiters: [],
					};
					runsByAgentId.set(s.id, run);
					persistHistory(run);
					armDeadline(run);
					const pending = dispatchEvents.get(s.id) ?? [];
					dispatchEvents.delete(s.id);
					for (const ev of pending) void handleEvent(ev).catch(() => {});
				},
			});
		} catch (e) {
			// Rejection may arrive BEFORE the failed process exits. Keep the
			// reservation until physical stop, even for readiness/accept failures.
			if (createdId) {
				await rt().retire(createdId);
				dispatchEvents.delete(createdId);
			}
			if (reservations.get(realWorkspace) === reservation) reservations.delete(realWorkspace);
			const message = e instanceof Error ? e.message : String(e);
			// Missing provider extension: fail fast BEFORE any process existed.
			// blocked, not unsupported — the profile itself is fine; the requested
			// model cannot run on this machine until the provider package is
			// installed. dispatched:false, nothing was spawned.
			if (e instanceof ProviderExtensionError) {
				return fail("blocked", workspace, message);
			}
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

		return waitRun(snap.id, { timeoutSec: args.waitTimeoutSec, signal, onUpdate, hasPendingMessages });
	}

	async function waitRun(agentId: string, args: WorkspaceWaitArgs = {}): Promise<WorkspaceToolResult> {
		const run = mustRun(agentId);
		if (run.terminal || run.state === "waiting_input") return ok(runOutcome(run));
		const stopStatus = startLiveStatus(run, args.onUpdate);
		try {
			const reason = await new Promise<string | undefined>((resolve) => {
				let done = false;
				let wakeTimer: ReturnType<typeof setInterval> | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const finishWait = (reason?: string) => {
					if (done) return;
					done = true;
					if (timer) clearTimeout(timer);
					if (wakeTimer) clearInterval(wakeTimer);
					args.signal?.removeEventListener("abort", onAbort);
					const idx = run.waiters.indexOf(w);
					if (idx !== -1) run.waiters.splice(idx, 1);
					resolve(reason);
				};
				const w = () => finishWait();
				const onAbort = () => finishWait(ABORT_DETACH_REASON);
				run.waiters.push(w);
				timer = setTimeout(() => finishWait("wait_timeout: run continues under the same deadline"),
					(args.timeoutSec ?? DEFAULT_WAIT_MS / 1000) * 1000);
				timer.unref?.();
				args.signal?.addEventListener("abort", onAbort, { once: true });
				if (args.signal?.aborted) { onAbort(); return; }
				if (args.hasPendingMessages) {
					wakeTimer = setInterval(() => {
						if (ownDeliveryInFlight()) return;
						try { if (args.hasPendingMessages!()) finishWait(STEERING_WAKE_REASON); } catch {}
					}, steeringWakePollMs);
					wakeTimer.unref?.();
				}
			});
			// Meaningful state wins over a simultaneous release/timeout. During
			// stop/Git reads this remains running, never an incomplete terminal.
			const outcome = runOutcome(run);
			return ok(outcome.status === "running" && reason ? { ...outcome, reason } : outcome);
		} finally { stopStatus(); }
	}

	function mustRun(agentId: string): WorkspaceAgentRun {
		const run = runsByAgentId.get(agentId);
		if (!run) throw new Error(`unknown workspace agent id: ${agentId}`);
		return run;
	}

	async function steerRun(agentId: string, message: string): Promise<void> {
		const run = mustRun(agentId);
		if (run.terminal || run.deadlineFired || (run.state !== "running" && run.state !== "waiting_input")) {
			throw new Error(`cannot steer workspace-owned agent ${agentId}: run is settling or terminating`);
		}
		await rt().steer(agentId, message);
	}

	async function cancelRun(agentId: string): Promise<void> {
		const run = mustRun(agentId);
		if (!claimTermination(run)) {
			// Cancellation must not report success while another claimer is still
			// stopping the process or collecting facts. This is not a Main wait cap.
			if (!run.terminal) await new Promise<void>((resolve) => run.waiters.push(resolve));
			return;
		}
		await rt().cancel(agentId);
		await finish(run, { status: "blocked", reason: "cancelled_by_main", lastOutput: await lastOutput(agentId), childMayHaveMutatedRepo: true });
	}

	// ----------------------------------------------------------------- query

	function runOutcome(run: WorkspaceAgentRun): WorkspaceRunOutcome {
		const base: WorkspaceRunOutcome = {
			status: "blocked",
			dispatched: true,
			workspace: run.workspace,
			agentId: run.agentId,
			...observations(run),
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
		// A bounded wait may return while running/terminating; this is never
		// partial/blocked and must not trigger inspect + repair orchestration.
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
			...observations(run),
			...(!run.terminal && run.ladder > 0 ? { ladder: { step: run.ladder, max: LADDER_MAX } } : {}),
		};
	}

	function observations(run: WorkspaceAgentRun) {
		const now = Date.now();
		run.progress = loadProgress(run.agentId, rt().getResultsDir()) ?? run.progress;
		return {
			deadlineAt: run.deadline,
			deadlineMsLeft: Math.max(0, run.deadline - now),
			...(run.progress ? { progress: { ...run.progress }, progressAgeMs: Math.max(0, now - run.progress.updatedAt) } : {}),
		};
	}

	function persistHistory(run: WorkspaceAgentRun): void {
		const view = runView(run.agentId)!;
		const { deadlineMsLeft: _left, progressAgeMs: _age, ladder: _ladder, ...history } = compactRunView(view);
		rt().setRunHistory(run.agentId, history);
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
		waitRun,
		steerRun,
		cancelRun,
		runView,
		isManaged: (agentId: string) => runsByAgentId.has(agentId),
	};
}

// -------------------------------------------------------------------- helpers

/** Shared narrow projection for status, inherited inspection and persisted history. */
export function compactRunView(view: WorkspaceRunView): RunHistory & {
	deadlineMsLeft: number; progressAgeMs?: number; ladder?: { step: number; max: number };
} {
	return {
		workspace: view.workspace, state: view.state, deadlineMsLeft: view.deadlineMsLeft,
		...(view.deadlineAt !== undefined ? { deadlineAt: view.deadlineAt } : {}),
		...(view.progress ? { progress: { ...view.progress }, progressAgeMs: view.progressAgeMs } : {}),
		...(view.terminal ? {
			status: view.terminal.status as "done" | "partial" | "blocked",
			terminal: {
				status: view.terminal.status as "done" | "partial" | "blocked",
				...(view.terminal.reason !== undefined ? { reason: view.terminal.reason } : {}),
				...(view.terminal.result ? { result: { status: view.terminal.result.status, summary: view.terminal.result.summary } } : {}),
			},
		} : {}),
		...(view.ladder ? { ladder: view.ladder } : {}),
	};
}

/** Add deterministic time-budget instructions only to the dispatched prompt. */
function repoOwnerPrompt(task: string, deadlineMs: number): string {
	const reserveMs = Math.min(
		deadlineMs,
		Math.max(MIN_FINALIZATION_RESERVE_MS, deadlineMs * 0.2),
	);
	const finalizationStartsAtMs = Math.max(0, deadlineMs - reserveMs);
	const seconds = (milliseconds: number): string =>
		Number((milliseconds / 1000).toFixed(3)).toString();
	return (
		`${task}\n\n` +
		`Runtime budget (enforced):\n` +
		`- Hard deadline: ${seconds(deadlineMs)} seconds.\n` +
		`- Finalization reserve: ${seconds(reserveMs)} seconds ` +
		`(starts ${seconds(finalizationStartsAtMs)} seconds after dispatch).\n` +
		`At the reserve boundary, stop starting new scope, commit coherent work, ` +
		`run only checks that fit, and call report_result with status partial rather ` +
		`than letting the deadline kill a mid-change worktree.`
	);
}

/**
 * Objective state of the workspace, read mechanically from Git.
 * The three settled-state checks for a `done` product outcome:
 * accessible git repository, current HEAD, clean working tree
 * (untracked non-ignored files count as dirt; ignored files — build
 * output, caches — do not). `facts` is present whenever Git could read
 * at least status, so even a rejected done carries what Main needs.
 */
export type GitState = { ok: true; facts: GitFacts } | { ok: false; problem: string; facts?: GitFacts };

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
 * the plain `subagent` tool (nested repo-local helpers; `model` and `role` apply)
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
