/**
 * Shared types for the subagents extension.
 *
 * This module must stay free of pi imports so pure unit tests (bun test)
 * can import it without the pi package being resolvable.
 */

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
}

export interface PendingQuestion {
	/** RPC extension_ui_request id used to deliver the answer. */
	requestId: string;
	question: string;
	askedAt: number;
}

/** Immutable point-in-time view of an agent. */
export interface AgentSnapshot {
	id: string;
	label: string;
	state: AgentState;
	task: string;
	cwd: string;
	model?: string;
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
	| { kind: "needs_input"; agentId: string; label: string; question: string };

export type WaitOutcome =
	| { status: "completed"; summary: string }
	| { status: "failed"; reason: string }
	| { status: "cancelled" }
	| { status: "needs_input"; question: string }
	| { status: "timeout"; state: AgentState };

/**
 * Boundary between model-facing subagent semantics and the concrete runtime.
 *
 * The tool and command layers depend only on this interface; the current
 * implementation is local child processes speaking pi RPC, but it can be
 * replaced (e.g. an external daemon) without changing the model contract.
 */
export interface SubagentRuntime {
	/** Start a child agent. Resolves quickly, once the initial prompt is accepted. */
	spawn(opts: SpawnOptions): Promise<AgentSnapshot>;
	/** Redirect a running child mid-flight. */
	steer(agentId: string, message: string): Promise<void>;
	/** Queue work for a child: after the current run, or as a new run when idle. */
	followUp(agentId: string, message: string): Promise<void>;
	/** Block until the agent reaches a meaningful event (or timeout). */
	wait(
		agentId: string,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitOutcome>;
	/** Lazily fetch the full persisted result of an agent. */
	result(agentId: string): Promise<AgentResult | null>;
	/** Answer a pending ask_parent question; the child resumes. */
	respond(agentId: string, answer: string): Promise<void>;
	/** Stop an agent: pi abort, then SIGTERM, then SIGKILL escalation. */
	cancel(agentId: string): Promise<void>;
	/** Snapshot one agent (by id) or all agents. */
	inspect(agentId?: string): AgentSnapshot[];
	/** Subscribe to model-visible events; returns an unsubscribe function. */
	onEvent(cb: (ev: SubagentModelEvent) => void): () => void;
	/** Kill all live children without latching the runtime shut. */
	cancelAll(): Promise<void>;
	/** Kill all live children and latch the runtime shut (main shutdown). */
	shutdown(): Promise<void>;
}
