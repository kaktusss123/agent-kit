/**
 * Delivery wiring shared by the shipped extension and the live driver:
 * model-visible runtime events reach the main model as compact custom
 * messages via pi.sendMessage with deliverAs:"steer" + triggerTurn:true.
 *
 * pi 0.85.1 behavior (verified against the installed build): busy main ->
 * queued as steering, delivered at the next safe turn boundary; idle main ->
 * a fresh agent run starts. The child transcript never enters main context.
 *
 * Note: pi.sendMessage rejections are caught inside pi and surfaced as
 * extension_error events, so there is no meaningful synchronous retry path
 * here. A message lost to a rare race (e.g. compaction in progress) is gone;
 * the agent's status/result remain queryable via the subagent tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatModelEvent } from "./delivery";
import type { LocalSubagentRuntime } from "./controller";

export function attachDelivery(pi: ExtensionAPI, runtime: LocalSubagentRuntime): void {
	runtime.onEvent((ev) => {
		const text = formatModelEvent(ev);
		pi.sendMessage(
			{
				customType: SUBAGENT_EVENT_TYPE,
				content: text,
				display: true,
				details: { agentId: ev.agentId, kind: ev.kind },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	});
}

const SUBAGENT_EVENT_TYPE = "subagent-event";
