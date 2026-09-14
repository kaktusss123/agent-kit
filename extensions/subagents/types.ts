/**
 * Shared types for the subagents extension.
 *
 * This module must stay free of pi imports so pure unit tests (bun test)
 * can import it without the pi package being resolvable.
 */
import type { AskInput } from "../ask/contract";

/** Logical agent state. Process liveness is tracked separately (`alive`). */
export type AgentState =
	| "starting"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "cancelled";

export interface SpawnOptions {
	/** Initial task prompt for the child agent. */
	task: string;
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
	 * the entry must report as registered. When set, the child's initial task
	 * prompt is sent only after every listed entry confirmed readiness over
	 * the extension UI protocol; otherwise the spawn fails with the child
	 * killed and the task never reaching the model.
	 *
	 * This map is also the child-side truth: it travels verbatim to THIS
	 * spawn via the `PI_SUBAGENT_READINESS_CONTRACT` env var, which the
	 * subagents-owned readiness probe observes (generic children never get
	 * the env var). The child carries no global readiness policy.
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
	/** Terminal status of the last run: completed | failed | cancelled. */
	status: "completed" | "failed" | "cancelled";
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
	| { status: "timeout"; state: AgentState };
