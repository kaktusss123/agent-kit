/**
 * Readiness handshake protocol shared by the main-side controller and the
 * child-side readiness probe.
 *
 * Why: static entrypoint preflight proves files exist, and (since pi exits on
 * extension load errors in RPC mode) a broken import kills the child — but
 * neither proves that the extensions actually INITIALIZED (registered their
 * tools, bound their guards). Profiled children prove it themselves: the
 * readiness probe (`readiness-probe.ts`, the last profile entry) reads the
 * real session tool set once from its `session_start` handler and reports per
 * contract entry; the controller validates against this contract and only
 * then sends the task prompt (fail closed — the task never reaches the model
 * when readiness fails).
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
 * Contract transport: the readiness contract is PER-SPAWN, not global. The
 * controller serializes the spawn's `SpawnOptions.readinessEntries` into the
 * child env var `READINESS_CONTRACT_ENV` and the probe parses it there — a
 * missing, unparseable, or wrong-shape contract means the probe registers
 * nothing and the controller-side readiness timeout fails the spawn (fail
 * closed; the probe never falls back to any global default). This module
 * owns the env name, the validating parser, and the protocol types; the
 * probe importing protocol constants from here stays fine, but the probe
 * must not read `PROFILE_READINESS` as runtime configuration: any spawn can
 * declare a different contract, and the child must report exactly what its
 * controller declared.
 *
 * This module stays free of runtime pi imports so both sides (and bun unit
 * tests) can use it.
 *
 * Module cycle note: the only reason this file imports from
 * `./reporting-bridge` is the reporting entry id constant; reporting-bridge
 * no longer imports this module (readiness signaling moved into the probe),
 * so the dependency is acyclic and the entry id keeps exactly one source of
 * truth.
 */

import { REPORTING_ENTRY_ID } from "./reporting-bridge";

/** Marker embedded in every readiness notify payload. */
export const READINESS_PROTOCOL = "pi-subagents-readiness";

/**
 * Child env var carrying the per-spawn readiness contract (JSON, the exact
 * `SpawnOptions.readinessEntries` map the controller validated against).
 * Written by the controller at spawn time; parsed by the readiness probe at
 * registration. Generic children (no readiness entries) never see it.
 */
export const READINESS_CONTRACT_ENV = "PI_SUBAGENT_READINESS_CONTRACT";

/**
 * Entry id of the task-workspace extension inside the RepoOwner profile.
 * Owned here (the controller's profile contract), never by the capability
 * extension itself.
 */
export const TASK_WORKSPACE_ENTRY_ID = "task-workspace";

/**
 * The RepoOwner readiness contract — the canonical declared default for the
 * entry id -> required tools mapping (SPEC R2), owned here (the controller's
 * profile contract), never by the capability extensions themselves.
 *
 * `workspace_agent` declares it per spawn (`SpawnOptions.readinessEntries`);
 * the controller validates the child's reports against that map and ships
 * the same map to the child via `READINESS_CONTRACT_ENV`. The readiness
 * probe observes exactly what was declared — it must not import this
 * constant as runtime configuration (a per-spawn contract may differ, and
 * the child must not carry global policy). Capability extensions
 * (task-workspace, reporting-bridge) declare nothing — they must not know
 * they are profiled.
 */
export const PROFILE_READINESS: Record<string, string[]> = {
	[TASK_WORKSPACE_ENTRY_ID]: [
		"task_status",
		"ensure_task_repo",
		"checkpoint_commit",
		"remove_task_lane",
	],
	[REPORTING_ENTRY_ID]: ["report_result"],
};

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

/**
 * Validate a raw per-spawn readiness contract (the JSON body of
 * `READINESS_CONTRACT_ENV`): a plain object with string keys and values that
 * are arrays of strings. Missing, unparseable, or wrong-shape input yields
 * `undefined` so callers can fail closed instead of guessing a contract.
 */
export function parseReadinessContract(raw: string | undefined): Record<string, string[]> | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const contract: Record<string, string[]> = {};
	for (const [entry, tools] of Object.entries(parsed as Record<string, unknown>)) {
		if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) return undefined;
		contract[entry] = tools as string[];
	}
	return contract;
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
