/**
 * Readiness handshake protocol shared by the main-side controller and the
 * child-side profiled extensions.
 *
 * Why: static entrypoint preflight proves files exist, and (since pi exits on
 * extension load errors in RPC mode) a broken import kills the child — but
 * neither proves that the extensions actually INITIALIZED (registered their
 * tools, bound their guards). Profiled children prove it themselves: each
 * additional extension entry opens a `workspace_readiness` dialog from its
 * `session_start` handler reporting the tool set it registered; the
 * controller acks, validates against the spawn's readiness contract, and
 * only then sends the task prompt (fail closed — the task never reaches the
 * model when readiness fails).
 *
 * Transport: the standard RPC extension UI protocol, using fire-and-forget
 * `notify` requests. Blocking dialogs (input) would deadlock: the RPC stdin
 * reader only attaches AFTER rebindSession completes, so the controller's
 * dialog response could never arrive while session_start handlers are still
 * running. With notify, the request line is written immediately; the
 * controller treats its arrival as the readiness confirmation (the payload
 * carries the entry id and the registered tool set) — no ack round-trip
 * exists, and the controller-side readiness timeout stays the enforcer.
 *
 * This module stays free of runtime pi imports so both sides (and bun unit
 * tests) can use it: the child helper receives the ExtensionAPI object.
 */

/** Marker embedded in every readiness notify payload. */
export const READINESS_PROTOCOL = "pi-subagents-readiness";

/** Env var carrying the comma-separated readiness entry ids this child must confirm. */
export const READINESS_ENV = "PI_SUBAGENT_READINESS";

export interface ReadinessPayload {
	/** Protocol marker, always "pi-subagents-readiness". */
	protocol: string;
	entry: string;
	ok: boolean;
	/** All tool names visible in the child session at session_start. */
	tools: string[];
	/** Required tools missing from the registered set. */
	missing: string[];
}

export function parseReadinessPayload(raw: string | undefined): ReadinessPayload | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<ReadinessPayload> | undefined;
		if (!parsed || parsed.protocol !== READINESS_PROTOCOL) return undefined;
		if (typeof parsed.entry !== "string" || typeof parsed.ok !== "boolean") return undefined;
		if (!Array.isArray(parsed.tools) || !Array.isArray(parsed.missing)) return undefined;
		return {
			protocol: parsed.protocol,
			entry: parsed.entry,
			ok: parsed.ok,
			tools: parsed.tools.filter((t): t is string => typeof t === "string"),
			missing: parsed.missing.filter((t): t is string => typeof t === "string"),
		};
	} catch {
		return undefined;
	}
}

/**
 * Child-side readiness signaling. Called by an additional extension entry's
 * factory when it is loaded into a profiled child; a no-op everywhere else
 * (the entry id must be requested via PI_SUBAGENT_READINESS, which the
 * controller sets only for children with a readiness contract — plain extra
 * extensions in non-profiled children never open the dialog).
 */
export function signalChildReadiness(
	pi: {
		on(event: "session_start", handler: (event: unknown, ctx: {
			ui: {
				notify(message: string, notifyType?: "info" | "warning" | "error"): void;
			};
		}) => unknown): unknown;
		getAllTools(): Array<{ name: string }>;
	},
	entryId: string,
	requiredTools: string[],
): void {
	const requested = (process.env[READINESS_ENV] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!requested.includes(entryId)) return;
	pi.on("session_start", (_event, ctx) => {
		let tools: string[] = [];
		let listed = true;
		try {
			tools = pi.getAllTools().map((t) => t.name);
		} catch {
			listed = false;
		}
		const missing = requiredTools.filter((t) => !tools.includes(t));
		const payload: ReadinessPayload = {
			protocol: READINESS_PROTOCOL,
			entry: entryId,
			ok: listed && missing.length === 0,
			tools,
			missing,
		};
		try {
			// Fire-and-forget: the request line reaches the controller
			// immediately (see module docstring — no ack round-trip exists).
			ctx.ui.notify(JSON.stringify(payload), "info");
		} catch {
			// Never let the handshake break child startup; the controller-side
			// readiness timeout is the enforcement mechanism.
		}
	});
}
