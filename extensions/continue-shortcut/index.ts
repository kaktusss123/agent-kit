/**
 * continue-shortcut — `.`/`c` continue shortcut for pi, ported from oh-my-pi.
 *
 * Submitting a bare "." or "c" resumes the agent with a hidden agent-authored
 * continue directive instead of a visible user message, so the model continues
 * prior intent rather than reacting to a stray dot. While the agent is busy,
 * the directive degrades to a queued follow-up delivered after the run.
 *
 * Behavior verified against pi's RPC and print modes: the `input` event sees
 * the raw text before expansion; `{ action: "handled" }` suppresses the user
 * message entirely; `pi.sendMessage(..., { deliverAs: "followUp",
 * triggerTurn: true })` starts an idle run immediately and queues while busy.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ContinueDecision, CONTINUE_SHORTCUT_CUSTOM_TYPE, decideContinueShortcut } from "./core.ts";

export default function (pi: ExtensionAPI) {
	// Prompt text lives in a .md file next to this module. pi loads extensions
	// through jiti (no Bun-style `.md` import attributes), so read it at wiring
	// time (same pattern as the todo extension).
	const continuePrompt = readFileSync(new URL("./prompts/manual-continue.md", import.meta.url), "utf8").trim();

	pi.on("input", async (event) => {
		const decision: ContinueDecision = decideContinueShortcut({
			text: event.text,
			hasImages: (event.images?.length ?? 0) > 0,
			streamingBehavior: event.streamingBehavior,
		});
		if (decision === "pass-through") return { action: "continue" };
		if (decision === "trigger") {
			await pi.sendMessage(
				{
					customType: CONTINUE_SHORTCUT_CUSTOM_TYPE,
					content: continuePrompt,
					display: false,
				},
				// Idle: triggerTurn starts the run now. Busy: triggerTurn is ignored
				// and the directive is delivered as a follow-up after the run.
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		return { action: "handled" };
	});
}
