/**
 * agent-events — semantic runtime events for pi.
 *
 * Observes pi's lifecycle hooks and publishes a small terminal-agnostic event
 * model to AgentEventSink consumers. The only sink today is WarpCliAgentSink
 * (Warp CLI Agent Protocol v1 over OSC 777); a future control-plane transport
 * is just another sink. The model never calls anything from the LLM side —
 * lifecycle is observed automatically, there is no telemetry tool.
 *
 * Terminal sink activation invariants:
 * - only the top-level interactive TUI session (mode "tui" + stdout TTY)
 *   creates the Warp sink, so headless/subagent pi processes never write
 *   escape sequences into pipes or protocol streams;
 * - Warp must advertise WARP_CLI_AGENT_PROTOCOL_VERSION >= 1;
 * - sink errors are swallowed — they can never break agent execution.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyRunOutcome, truncateCodePoints, type RunOutcome } from "./classify";
import { shouldCreateTerminalSink, type AgentEvent, type AgentEventSink } from "./events";
import { isWarpProtocolAdvertised } from "./warp";
import { WarpCliAgentSink } from "./warp-sink";

/** Version of this integration, reported to Warp via session_start. */
const PLUGIN_VERSION = "0.1.0";

export default function agentEventsExtension(pi: ExtensionAPI): void {
	let sink: AgentEventSink | undefined;
	let query: string | undefined;
	let lastOutcome: RunOutcome | undefined;

	function emit(event: AgentEvent): void {
		if (!sink) return;
		try {
			const result = sink.emit(event);
			// Sync sinks are the norm; keep async ones from rejecting unhandled.
			if (result instanceof Promise) result.catch(() => {});
		} catch {
			// Sink failures must never break agent execution.
		}
	}

	pi.on("session_start", (event, ctx) => {
		sink = undefined;
		query = undefined;
		lastOutcome = undefined;

		// Re-evaluated on every start: /new, /resume, /fork rebind the session
		// (new session id), and mode never changes for a process lifetime.
		if (!shouldCreateTerminalSink(ctx.mode, process.stdout.isTTY)) return;
		if (!isWarpProtocolAdvertised()) return;

		const sessionId = ctx.sessionManager.getSessionId();
		sink = new WarpCliAgentSink({
			sessionId,
			getCwd: () => ctx.sessionManager.getCwd(),
			pluginVersion: PLUGIN_VERSION,
		});
		emit({ type: "session_started", sessionId });
		if (event.reason !== "startup") {
			// Keep Warp's query context in sync across session switches.
			query = undefined;
		}
	});

	pi.on("before_agent_start", (event) => {
		query = truncateCodePoints(event.prompt);
	});

	pi.on("agent_start", () => {
		emit({ type: "run_started", query });
	});

	pi.on("agent_end", (event) => {
		lastOutcome = classifyRunOutcome(event.messages);
	});

	// agent_settled fires only when no auto-retry, auto-compaction retry, or
	// queued continuation remains, so Warp never flashes a final state mid-run.
	pi.on("agent_settled", () => {
		const outcome = lastOutcome ?? { status: "completed" as const };
		lastOutcome = undefined;
		const q = query;
		query = undefined;
		if (outcome.status === "failed") {
			emit({ type: "run_failed", query: q, response: outcome.response, error: outcome.error });
		} else if (outcome.status === "aborted") {
			emit({ type: "run_aborted", query: q });
		} else {
			emit({ type: "run_completed", query: q, response: outcome.response });
		}
	});

	pi.on("ui_prompt_start", (event) => {
		emit({ type: "attention_required", kind: event.kind, title: event.title });
	});

	pi.on("ui_prompt_end", (event) => {
		emit({ type: "attention_resolved", kind: event.kind, title: event.title });
	});

	pi.on("session_shutdown", () => {
		// No Warp "shutdown" event exists; drop the sink so nothing is written
		// after teardown. Warp keeps showing the last known status.
		sink = undefined;
		query = undefined;
		lastOutcome = undefined;
	});
}
