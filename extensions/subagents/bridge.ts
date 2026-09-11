/**
 * Child-side bridge extension for subagents.
 *
 * Loaded into every subagent via `pi --mode rpc --no-extensions -e bridge.ts`.
 * It provides exactly one capability beyond the normal coding tools:
 * `ask_parent`, which suspends the child (only the child) until the parent
 * answers through the standard RPC extension_ui_request/response protocol.
 *
 * The bridge registers nothing else and never loads the parent's extension
 * stack, so recursive spawning is impossible by construction.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // survives long parent turns

export default function (pi: ExtensionAPI) {
	let askCount = 0;

	pi.registerTool({
		name: "ask_parent",
		label: "Ask Parent",
		description:
			"Ask the parent agent for a missing decision or piece of information and wait for the answer. " +
			"Use only when you cannot proceed without it; the parent sees the question asynchronously " +
			"and you are suspended until it responds.",
		parameters: Type.Object({
			question: Type.String({ description: "Precise, self-contained question for the parent" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timeoutMs = Number(process.env.PI_SUBAGENT_ASK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
			// In RPC mode this emits an extension_ui_request (method "input",
			// title "ask_parent") and blocks until the parent sends the matching
			// extension_ui_response. The tool's abort signal (main cancel ->
			// child abort) dismisses the dialog gracefully.
			const answer = await ctx.ui.input("ask_parent", params.question, {
				timeout: timeoutMs,
				signal,
			});
			return {
				content: [
					{
						type: "text",
						text:
							answer === undefined
								? "(no answer — the parent is unavailable or the question timed out; proceed with your best judgment and state your assumption)"
								: answer,
					},
				],
				details: { question: params.question, answered: answer !== undefined, seq: ++askCount },
			};
		},
	});
}
