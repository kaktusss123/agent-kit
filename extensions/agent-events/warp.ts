/**
 * Warp CLI Agent Protocol wire format (protocol v1), verified against
 * warpdotdev/warp @ 728c02f:
 * - crates/warp_terminal/src/model/ansi/mod.rs  — OSC 777;notify parsing
 * - app/src/terminal/cli_agent_sessions/event/mod.rs + v1.rs — JSON parsing
 * - crates/warp_core/src/cli_agent_protocol.rs  — sentinel + version env
 * - crates/warp_tui/src/cli_agent_osc_event_publisher.rs — reference emitter
 * - crates/warp_terminal/src/model/escape_sequences.rs — tmux passthrough
 *
 * Frame: ESC ] 777 ; notify ; warp://cli-agent ; <JSON> BEL
 * Under tmux the frame is DCS-wrapped with doubled ESC bytes; attention-worthy
 * events additionally append one BEL after the DCS ST so tmux monitor-bell
 * flags the pane.
 */

/** Sentinel title Warp dispatches CLI-agent notifications on. */
export const WARP_SENTINEL = "warp://cli-agent";

/** Only schema version Warp currently parses (VERSIONED_PARSERS = [v1]). */
export const WARP_PROTOCOL_VERSION = 1;

/**
 * Agent identifier Warp resolves to CLIAgent::Pi via command_prefixes()
 * (app/src/terminal/cli_agent.rs: Pi => ["pi"]).
 */
export const WARP_AGENT_ID = "pi";

/**
 * True when the hosting terminal advertised a protocol version we can speak.
 * Warp injects WARP_CLI_AGENT_PROTOCOL_VERSION only when its notifications
 * feature is enabled; Number("garbage") is NaN, which fails the comparison.
 */
export function isWarpProtocolAdvertised(env: Record<string, string | undefined> = process.env): boolean {
	return Number(env.WARP_CLI_AGENT_PROTOCOL_VERSION) >= WARP_PROTOCOL_VERSION;
}

/** True when running inside tmux (frames must be DCS-wrapped for passthrough). */
export function isInsideTmux(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.TMUX);
}

/**
 * Warp-side event payload (v1 schema subset we emit). Unknown/omitted fields
 * are fine: Warp's parser treats everything except `event` as optional.
 */
export type WarpEventPayload =
	| { event: "session_start"; plugin_version?: string }
	| { event: "prompt_submit"; query?: string }
	| { event: "stop"; query?: string; response?: string }
	| { event: "stop_failure"; query?: string; response?: string; error_type?: string }
	| { event: "question_asked"; summary?: string }
	| { event: "permission_replied" };

/** Envelope fields appended over the payload; they win on key collisions. */
export interface WarpEnvelope {
	sessionId: string;
	cwd: string;
	project: string;
	pluginVersion: string;
}

/**
 * vte's OSC parser (warpdotdev/vte @ 4b399c8, src/lib.rs) splits the OSC string
 * on every literal `;` byte and records at most MAX_OSC_PARAMS = 16 parameters;
 * everything past the cap is dropped. Warp's OSC 777 handler reassembles the
 * body from params[3..] ("777", "notify", sentinel take three), so a JSON body
 * containing >= 13 semicolons gets truncated mid-string and Warp's
 * serde_json::from_str silently discards the whole event — the tab then stays
 * "in progress" until the next successful prompt_submit.
 *
 * `;` is not a structural JSON character, so every `;` in the serialized text
 * sits inside a string literal, and `\u003b` is a valid JSON escape that
 * decodes back to `;`. Escaping therefore makes the frame lossless for both
 * the param splitter and serde.
 */
function escapeOscParamSplitter(json: string): string {
	return json.replaceAll(";", "\\u003b");
}

/** Build the raw OSC 777 frame (no tmux wrapping, no attention bell). */
export function buildWarpFrame(payload: WarpEventPayload, envelope: WarpEnvelope): string {
	const body = escapeOscParamSplitter(
		JSON.stringify({
			...payload,
			v: WARP_PROTOCOL_VERSION,
			agent: WARP_AGENT_ID,
			session_id: envelope.sessionId,
			cwd: envelope.cwd,
			project: envelope.project,
			plugin_version: envelope.pluginVersion,
		}),
	);
	return `\x1b]777;notify;${WARP_SENTINEL};${body}\x07`;
}

/** Wrap a control sequence in tmux's DCS passthrough envelope. */
export function wrapTmuxPassthrough(payload: string): string {
	return `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Finalize a frame for the actual terminal stream: DCS-wrap under tmux and,
 * for attention-worthy events, append one outer BEL after the DCS ST so tmux
 * monitor-bell flags the pane. The inner OSC's own BEL terminator does not
 * drive the outer bell after wrapping.
 */
export function finalizeWarpFrame(frame: string, options: { tmux: boolean; attention: boolean }): string {
	if (!options.tmux) return frame;
	const wrapped = wrapTmuxPassthrough(frame);
	return options.attention ? `${wrapped}\x07` : wrapped;
}
