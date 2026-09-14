/**
 * Child-side `ask` tool builder — the subagent implementation of the
 * canonical ask contract.
 *
 * The tool the child model sees is exactly `ask` with the shared canonical
 * schema; nothing here mentions parents, controllers, or transports (the
 * child neither knows nor needs to know who answers). The environment
 * difference is entirely inside execute's injected UI context: in a subagent
 * `ctx.ui.input` is the pi RPC extension-UI input, whose request the
 * controller intercepts and routes to Main. The structured AskInput travels
 * through the RPC request payload losslessly; the returned text is the
 * resolver's answer.
 *
 * No pi imports: the pi entry (bridge.ts) registers this builder directly,
 * and unit tests can exercise it with a fake ui.
 */
import type { Static } from "typebox";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_GUIDELINES,
	type AskInput,
	findReservedOptionLabel,
	normalizeAskArguments,
} from "../ask/contract";
import { AskSchema } from "../ask/ask-schema";

/** Wire title of the child UI dialog; the controller keys on it. */
export const ASK_WIRE_TITLE = "ask";

/** Minimal slice of the pi tool-execute context the child ask needs. */
export interface ChildAskContext {
	ui: {
		input(
			title: string,
			placeholder: string | undefined,
			opts?: { signal?: AbortSignal },
		): Promise<string | undefined>;
	};
}

export interface ChildAskToolDefinition {
	name: "ask";
	label: string;
	description: string;
	promptGuidelines: string[];
	parameters: typeof AskSchema;
	/**
	 * Argument-repair shim (ask/contract.ts), identical to the Main side:
	 * children must survive the same model mistakes (option-level `recommended`
	 * flags, boolean/label recommendations, extra properties).
	 */
	prepareArguments(args: unknown): AskInput;
	executionMode: "sequential";
	execute(
		toolCallId: string,
		params: AskInput,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ChildAskContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

export function buildChildAskTool(): ChildAskToolDefinition {
	let askCount = 0;
	return {
		name: "ask",
		label: "Ask",
		description: ASK_TOOL_DESCRIPTION,
		promptGuidelines: [...ASK_TOOL_GUIDELINES],
		parameters: AskSchema,
		prepareArguments: normalizeAskArguments,
		// The dialog surface is a single shared UI channel: run alone in the
		// tool batch so concurrent asks cannot interleave their requests.
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// OMP reserved-label invariant, identical to the Main-side guard:
			// fail the call instead of hopping the reserved label to the UI.
			const reserved = findReservedOptionLabel(params as AskInput);
			if (reserved) {
				return {
					content: [
						{
							type: "text",
							text: `Error: option label "${reserved}" collides with a runtime-added control; use a different label`,
						},
					],
					details: { error: "reserved option label" },
					isError: true,
				};
			}
			const request: AskInput = params as Static<typeof AskSchema>;
			// In RPC mode this emits an extension_ui_request (method "input",
			// title "ask") carrying the structured request as the payload, and
			// blocks until the controller answers or the tool is aborted (main
			// cancel -> child abort). There is deliberately no timeout that
			// could auto-select an answer: an unresolved decision must surface
			// as a cancellation, never as a guessed selection.
			const answer = await ctx.ui.input(ASK_WIRE_TITLE, JSON.stringify(request), { signal });
			const text =
				answer === undefined
					? "(no answer — the request was cancelled or the resolver stopped waiting; do not guess: state that this decision remains unresolved)"
					: answer;
			return {
				content: [{ type: "text", text }],
				details: { answered: answer !== undefined, seq: ++askCount },
			};
		},
	};
}
