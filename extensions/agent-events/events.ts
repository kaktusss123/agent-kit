/**
 * Semantic agent runtime events and the sink contract.
 *
 * The event model is terminal-agnostic: it is derived from pi's own lifecycle
 * hooks (agent_start/agent_end/agent_settled, ui_prompt_start/end,
 * session_start/shutdown) and must not carry transport-specific fields.
 * Sinks translate these events into their own wire protocols (Warp OSC 777
 * today, a future control-plane transport tomorrow).
 */

/** Kinds of blocking user-facing UI prompts pi reports via ui_prompt_*. */
export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

export type AgentEvent =
	| { type: "session_started"; sessionId: string }
	| { type: "run_started"; query?: string }
	| { type: "run_completed"; query?: string; response?: string }
	| { type: "run_failed"; query?: string; response?: string; error?: string }
	| { type: "run_aborted"; query?: string }
	| { type: "attention_required"; kind: UIPromptKind; title?: string }
	| { type: "attention_resolved"; kind: UIPromptKind; title?: string };

/**
 * A consumer of semantic agent events. Sinks must be cheap and best-effort:
 * delivery guarantees, retries, and acknowledgements are out of scope.
 */
export interface AgentEventSink {
	emit(event: AgentEvent): void | Promise<void>;
}

/**
 * Only the top-level interactive pi session may create a terminal sink.
 *
 * Environment checks alone are not sufficient: headless/subagent pi processes
 * inherit Warp's env vars (WARP_CLI_AGENT_PROTOCOL_VERSION etc.) but run with
 * a piped/socketed stdout and a non-TUI mode. Both conditions are required:
 *
 * - `mode === "tui"` excludes print (-p), json, and rpc mode runs.
 * - `stdout.isTTY` excludes child processes whose stdio is a pipe or socket
 *   even if they were somehow started in interactive mode.
 */
export function shouldCreateTerminalSink(mode: string, stdoutIsTTY: boolean | undefined): boolean {
	return mode === "tui" && stdoutIsTTY === true;
}
