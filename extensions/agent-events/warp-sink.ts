/**
 * WarpCliAgentSink: translates semantic agent events into Warp's CLI Agent
 * Protocol (OSC 777, v1) and writes them to the terminal stream.
 *
 * Best-effort by contract: emit() swallows transport errors so a broken or
 * hostile terminal stream can never break agent execution.
 */

import { basename } from "node:path";
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from "./events";
import {
	buildWarpFrame,
	finalizeWarpFrame,
	isInsideTmux,
	type WarpEnvelope,
	type WarpEventPayload,
} from "./warp";

/**
 * Semantic event -> Warp payload + attention flag.
 * Attention set (drives the tmux monitor bell): run outcomes and attention
 * requests, mirroring OMP's treatment of stop/stop_failure/permission/question.
 */
export function toWarpEvent(event: AgentRuntimeEvent): { payload: WarpEventPayload; attention: boolean } {
	switch (event.type) {
		case "session_started":
			return { payload: { event: "session_start" }, attention: false };
		case "run_started":
			return { payload: { event: "prompt_submit", query: event.query }, attention: false };
		case "run_completed":
			return { payload: { event: "stop", query: event.query, response: event.response }, attention: true };
		case "run_failed":
			return {
				payload: {
					event: "stop_failure",
					query: event.query,
					response: event.response,
					error_type: "error",
				},
				attention: true,
			};
		case "run_aborted":
			return { payload: { event: "stop_failure", query: event.query, error_type: "cancelled" }, attention: true };
		case "attention_required":
			return {
				payload: {
					event: "question_asked",
					summary: event.title ?? `Waiting for your ${event.kind}`,
				},
				attention: true,
			};
		case "attention_resolved":
			return { payload: { event: "permission_replied" }, attention: false };
	}
}

export interface WarpCliAgentSinkOptions {
	/** Session id reported in every frame's session_id field. */
	sessionId: string;
	/** Re-read per emit so /cd-style cwd changes are reflected. */
	getCwd: () => string;
	/** Version of this integration, reported via session_start. */
	pluginVersion: string;
	/** Terminal stream writer; defaults to process.stdout.write. */
	write?: (data: string) => void;
	/** Environment for tmux detection; defaults to process.env. */
	env?: Record<string, string | undefined>;
}

export class WarpCliAgentSink implements AgentRuntimeEventSink {
	private readonly envelope: Omit<WarpEnvelope, "cwd" | "project"> & { getCwd: () => string };
	private readonly write: (data: string) => void;
	private readonly tmux: boolean;

	constructor(options: WarpCliAgentSinkOptions) {
		this.envelope = {
			sessionId: options.sessionId,
			pluginVersion: options.pluginVersion,
			getCwd: options.getCwd,
		};
		this.write = options.write ?? ((data) => process.stdout.write(data));
		this.tmux = isInsideTmux(options.env);
	}

	emit(event: AgentRuntimeEvent): void {
		try {
			const { payload, attention } = toWarpEvent(event);
			const cwd = this.envelope.getCwd();
			const frame = buildWarpFrame(payload, {
				sessionId: this.envelope.sessionId,
				cwd,
				project: basename(cwd),
				pluginVersion: this.envelope.pluginVersion,
			});
			this.write(finalizeWarpFrame(frame, { tmux: this.tmux, attention }));
		} catch {
			// Terminal sink failures must never break agent execution.
		}
	}
}
