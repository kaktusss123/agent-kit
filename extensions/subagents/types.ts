/**
 * Shared types for the subagents extension.
 *
 * This module must stay free of pi imports so pure unit tests (bun test)
 * can import it without the pi package being resolvable.
 */
import type { AskInput } from "../ask/contract";
import type { RunHistory } from "./progress";

/** Logical agent state. Process liveness is tracked separately (`alive`). */
export type AgentState =
	| "starting"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "cancelled";

export interface SpawnOptions {
	/** Canonical task stored in controller records and results. */
	task: string;
	/** Optional child-only initial prompt; defaults to the canonical task. */
	initialPrompt?: string;
	/** Short human/model-friendly name shown in status and session name. */
	label?: string;
	/** Working directory for the child process (resolved against main cwd). */
	cwd?: string;
	/** Model pattern for the child (`provider/model`), passed as `--model`. */
	model?: string;
	/** Thinking level for the child, passed as `--thinking`. */
	thinking?: string;
	/**
	 * Extra extension entry files loaded into THIS child only (repeated
	 * `-e` flags), in addition to the shared base bridge. Strictly per-spawn:
	 * generic children get none, so their environment is unchanged.
	 */
	additionalExtensions?: string[];
	/**
	 * Readiness contract for the additional extensions: entry id -> tool names
	 * the entry must have registered. When set, the child's initial task
	 * prompt is sent only after the readiness probe reported the child's
	 * session tool set and every listed entry's required tools are present;
	 * otherwise the spawn fails with the child killed and the task never
	 * reaching the model.
	 *
	 * This contract stays MAIN-SIDE: the child carries no readiness policy —
	 * the probe only reports the observed tool set, and the controller
	 * validates it against this map. Generic children (no readiness entries)
	 * are unaffected: they are spawned byte-identically and never probed.
	 */
	readinessEntries?: Record<string, string[]>;
	/**
	 * Route this child's lifecycle events to the workspace layer instead of
	 * the generic subagent policy. Workspace-owned children get no generic
	 * `[subagent ...]` deliveries and are excluded from wait() (their event
	 * owner is the workspace run registry).
	 */
	eventRoute?: "workspace";
	/**
	 * Abort honored until the initial task prompt is RPC-accepted: an abort
	 * before acceptance kills the child and fails the spawn (dispatched:
	 * false). After acceptance the signal is ignored here — ownership moves
	 * to the caller (abort = detach).
	 */
	signal?: AbortSignal;
	/** Runtime-only publication hooks; workspace registration must precede child lifecycle events. */
	onCreated?: (snapshot: AgentSnapshot) => void;
	onAccepted?: (snapshot: AgentSnapshot) => void;
	/**
	 * Idle-exit delay (F003): ms after this child settles into a terminal
	 * state before its (never-self-exiting) process is retired. The terminal
	 * record is preserved (retire semantics). `<= 0` disables idle exit;
	 * undefined uses the runtime default (30 min).
	 */
	idleExitMs?: number;
}

export interface PendingQuestion {
	/** RPC extension_ui_request id used to deliver the answer. */
	requestId: string;
	/** The structured canonical ask request (lossless, schema-validated). */
	request: AskInput;
	/** Compact flat rendering for status/snapshot display. */
	question: string;
	askedAt: number;
}

/**
 * Latest session stats reported by the child's `get_session_stats` RPC:
 * cumulative token usage, cost, and the current context-window estimate the
 * child itself uses for compaction and footer display. Refreshed live during
 * runs (assistant `message_end` / `tool_execution_end`), so status views can
 * show real spend and context fill while the child still works.
 */
export interface SessionStats {
	tokens: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	/** Context-window estimate; `tokens`/`percent` are null right after compaction. */
	contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

/**
 * One bounded tool-activity entry distilled from the child's authoritative
 * `tool_execution_start` / `tool_execution_end` RPC events. `summary` is a
 * conservatively extracted, aggressively truncated argument preview
 * (path/command/query) — never a serialized argument blob, never tool output.
 */
export interface ToolActivity {
	name: string;
	summary?: string;
	startedAt: number;
	endedAt?: number;
}

/** Immutable point-in-time view of an agent. */
export interface AgentSnapshot {
	id: string;
	label: string;
	state: AgentState;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	alive: boolean;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	lastActivityAt: number;
	elapsedMs: number;
	sessionFile?: string;
	sessionId?: string;
	pendingQuestion?: string;
	lastError?: string;
	exitCode?: number | null;
	signal?: string | null;
	/** Latest live session stats (tokens, cost, context fill); absent until the first report. */
	stats?: SessionStats;
	/** Tool currently executing in the child (newest start while several run in parallel). */
	activeTool?: ToolActivity;
	/** Most recently finished tools, oldest first, hard-capped (status telemetry, not a log). */
	recentActivity?: ToolActivity[];
}

/** Persisted result for one agent run (the "lazy full result"). */
export interface AgentResult {
	id: string;
	label: string;
	task: string;
	cwd: string;
	/**
	 * Terminal status of the last run: completed | failed | cancelled. The
	 * extra value "running" is a SPAWN-TIME MARKER only (F003 reconciliation):
	 * written at process creation so an ungraceful parent death can never
	 * leave a phantom child; it is superseded by the terminal write at settle
	 * or reconciled to failed on parent restart. Every reader must treat
	 * "running" as "no final result yet" — never as an outcome.
	 */
	status: "running" | "completed" | "failed" | "cancelled";
	finalText?: string;
	summary?: string;
	failureReason?: string;
	sessionFile?: string;
	sessionId?: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	tokens?: { input: number; output: number; total: number; cost?: number };
	exitCode?: number | null;
	signal?: string | null;
	/**
	 * When the process was killed after this result had already settled
	 * (cancel/retire of a terminal record): kill timestamp. The result keeps
	 * its original status, endedAt, exitCode and signal.
	 */
	processKilledAt?: number;
	/** Child OS pid; recorded on spawn-time markers so operators can act on orphans. */
	pid?: number;
	/** Main session file that spawned this agent; enables per-session cost rollup. */
	parentSession?: string;
	/** Optional bounded workspace history. Not a resumable execution handle. */
	run?: RunHistory;
}

/**
 * A spawn-time marker of ANOTHER session still in "running" state on disk:
 * an orphan whose owning parent is gone or holds it in a dead in-memory
 * registry. This session must never rewrite it — only surface it.
 */
export interface ForeignRunningMarker {
	id: string;
	label: string;
	task: string;
	startedAt: number;
	pid?: number;
	/** now - startedAt, computed at listing time. */
	ageMs: number;
}

/** Model-visible runtime events. Everything noisier stays telemetry-only. */
export type SubagentModelEvent =
	| { kind: "completed"; agentId: string; label: string; summary: string }
	| { kind: "failed"; agentId: string; label: string; reason: string }
	| { kind: "cancelled"; agentId: string; label: string }
	| { kind: "needs_input"; agentId: string; label: string; question: string; request: AskInput }
	/** Workspace-routed only: a pending ask was resolved (respond or aborted child-side). */
	| { kind: "input_resolved"; agentId: string; label: string };

export type WaitOutcome =
	| { status: "completed"; summary: string }
	| { status: "failed"; reason: string }
	| { status: "cancelled" }
	| { status: "needs_input"; question: string; request?: AskInput }
	| { status: "timeout"; state: AgentState }
	/**
	 * Steering wake (tool layer only, never produced by the controller): the
	 * blocking wait was released because the user sent a message; the child
	 * keeps running and its completion still arrives as a background event.
	 */
	| { status: "released"; state: AgentState };
