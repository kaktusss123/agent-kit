/**
 * Readiness probe — additional extension entry for RepoOwner children
 * (the last entry of the profile, after all capability entries).
 *
 * Readiness is OBSERVED here, inside the subagents extension, instead of
 * being signaled by each capability extension (SPEC R2): task-workspace and
 * the reporting bridge must know nothing about the controller, its profile,
 * or the readiness protocol — the dependency direction stays
 * subagents -> task-workspace, never the reverse.
 *
 * Pure observer: registers NO tools and NO tool_call hooks (the reporting
 * bridge's staleness hook and task-workspace's mutation guard keep their
 * extension-order contract undisturbed). In its `session_start` handler it
 * reads the actual session tool set ONCE via `pi.getAllTools()` — pi fires
 * session_start only after ALL profile entries' factories have run, so the
 * set reflects every entry's registration — and emits the existing
 * fire-and-forget readiness notify per contract entry (PROFILE_READINESS,
 * imported from ./readiness; payload shape unchanged:
 * `{protocol, entry, ok, tools, missing}`). The controller-side
 * `confirmReadiness`, the readiness timeout, and fail-closed dispatch are
 * unchanged.
 *
 * This entry is only ever loaded into profiled children (the controller
 * passes the profile paths via `-e`; it is not part of any main-session
 * extension stack), so there is no "not profiled" mode to guard here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROFILE_READINESS, READINESS_PROTOCOL, type ReadinessPayload } from "./readiness";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		let tools: string[] = [];
		let listed = true;
		try {
			tools = pi.getAllTools().map((t) => t.name);
		} catch {
			// Tool listing failed: nothing can be proven initialized — report
			// every contract entry as failed (ok:false).
			listed = false;
		}
		for (const [entry, requiredTools] of Object.entries(PROFILE_READINESS)) {
			const missing = requiredTools.filter((t) => !tools.includes(t));
			const payload: ReadinessPayload = {
				protocol: READINESS_PROTOCOL,
				entry,
				ok: listed && missing.length === 0,
				tools,
				missing,
			};
			try {
				// Fire-and-forget: the request line reaches the controller
				// immediately (see readiness.ts — no ack round-trip exists).
				ctx.ui.notify(JSON.stringify(payload), "info");
			} catch {
				// Never let the handshake break child startup; the controller-
				// side readiness timeout is the enforcement mechanism.
			}
		}
	});
}
