/**
 * Readiness probe — additional extension entry for RepoOwner children
 * (the last entry of the profile, after all capability entries).
 *
 * Readiness is OBSERVED here, inside the subagents extension, instead of
 * being signaled by each capability extension: task-workspace and the
 * reporting bridge must know nothing about the controller, its profile, or
 * the readiness protocol — the dependency direction stays
 * subagents -> task-workspace, never the reverse.
 *
 * The child carries NO readiness policy: at `session_start` the probe reads
 * the actual session tool set ONCE via `pi.getAllTools()` — pi fires
 * session_start only after ALL profile entries' factories have run, so the
 * set reflects every entry's registration — and emits one fire-and-forget
 * readiness notify carrying that set. The controller validates the report
 * against ITS OWN per-spawn contract (`SpawnOptions.readinessEntries`) and
 * only then dispatches the task prompt. The probe registers NO tools and NO
 * tool_call hooks (the reporting bridge's staleness hook and
 * task-workspace's mutation guard keep their extension-order contract
 * undisturbed).
 *
 * This entry is only ever loaded into profiled children (the controller
 * passes the profile paths via `-e`; it is not part of any main-session
 * extension stack), so there is no "not profiled" mode to guard here. If
 * tool listing fails, the probe reports an empty set — the controller sees
 * every required tool missing and fails the spawn (fail closed).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { READINESS_PROTOCOL, type ReadinessPayload } from "./readiness.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		let tools: string[] = [];
		try {
			tools = pi.getAllTools().map((t) => t.name);
		} catch {
			// Tool listing failed: report an empty set — the controller will
			// find every required tool missing and fail the spawn.
			tools = [];
		}
		const payload: ReadinessPayload = { protocol: READINESS_PROTOCOL, tools };
		try {
			// Fire-and-forget: the request line reaches the controller
			// immediately (see readiness.ts — no ack round-trip exists).
			ctx.ui.notify(JSON.stringify(payload), "info");
		} catch {
			// Never let the handshake break child startup; the controller-
			// side readiness timeout is the enforcement mechanism.
		}
	});
}
