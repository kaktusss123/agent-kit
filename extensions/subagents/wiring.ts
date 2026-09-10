/**
 * Delivery wiring shared by the shipped extension and the live driver:
 * model-visible runtime events reach the main model as compact custom
 * messages via pi.sendMessage with deliverAs:"steer" + triggerTurn:true.
 *
 * pi 0.85.1 behavior (verified against the installed build): busy main ->
 * queued as steering, delivered at the next safe turn boundary; idle main ->
 * a fresh agent run starts. The child transcript never enters main context.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatModelEvent } from "./delivery";
import type { SubagentModelEvent, SubagentRuntime } from "./types";

export const SUBAGENT_EVENT_TYPE = "subagent-event";

export function attachDelivery(pi: ExtensionAPI, runtime: SubagentRuntime): void {
	runtime.onEvent((ev: SubagentModelEvent) => {
		const text = formatModelEvent(ev);
		const attempt = (retries: number): void => {
			try {
				pi.sendMessage(
					{
						customType: SUBAGENT_EVENT_TYPE,
						content: text,
						display: true,
						details: { agentId: ev.agentId, kind: ev.kind },
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
			} catch {
				// Rare races (e.g. compaction in progress) — retry shortly.
				if (retries > 0) setTimeout(() => attempt(retries - 1), 2000);
			}
		};
		attempt(3);
	});
}
