/**
 * Readiness handshake protocol shared by the main-side controller and the
 * child-side readiness probe.
 *
 * Why: static entrypoint preflight proves files exist, and (since pi exits on
 * extension load errors in RPC mode) a broken import kills the child — but
 * neither proves that the extensions actually INITIALIZED (registered their
 * tools, bound their guards). Profiled children prove it themselves: the
 * readiness probe (`readiness-probe.ts`, the last profile entry) reads the
 * real session tool set once from its `session_start` handler and reports it
 * to the controller; the controller validates the report against THIS
 * spawn's readiness contract (`SpawnOptions.readinessEntries`, kept on the
 * main side) and only then sends the task prompt (fail closed — the task
 * never reaches the model when readiness fails).
 *
 * Transport: the standard RPC extension UI protocol, using fire-and-forget
 * `notify` requests. Blocking dialogs (input) would deadlock: the RPC stdin
 * reader only attaches AFTER rebindSession completes, so the controller's
 * dialog response could never arrive while session_start handlers are still
 * running. With notify, the request line is written immediately; the
 * controller treats its arrival as the readiness report — no ack round-trip
 * exists, and the controller-side readiness timeout stays the enforcer.
 *
 * The child carries NO readiness policy: the probe reports what it observes
 * (the tool set), and the controller judges it against the per-spawn
 * contract. Requirement maps never travel to the child.
 *
 * This module stays free of runtime pi imports so both sides (and bun unit
 * tests) can use it.
 *
 * Module cycle note: the only reason this file imports from
 * `./reporting-bridge` is the reporting entry id constant; reporting-bridge
 * does not import this module, so the dependency is acyclic and the entry id
 * keeps exactly one source of truth.
 */

import { REPORTING_ENTRY_ID } from "./reporting-bridge";

/** Marker embedded in every readiness notify payload. */
export const READINESS_PROTOCOL = "pi-subagents-readiness";

/**
 * Entry id of the task-workspace extension inside the RepoOwner profile.
 * Owned here (the controller's profile contract), never by the capability
 * extension itself.
 */
export const TASK_WORKSPACE_ENTRY_ID = "task-workspace";

/**
 * Entry id of the subagents extension inside the RepoOwner profile: the
 * profile loads the SAME index the main session uses, so a workspace worker
 * can spawn plain `subagent` children (repo-local helpers) and pick their
 * modelClass (any saved class or "default") — its own model was fixed at
 * dispatch time by the spawn's modelClass or the repoOwner default chain.
 */
export const SUBAGENTS_ENTRY_ID = "subagents";

/**
 * Entry id of the base web-search extension every child carries (base
 * profile: bridge + web-search, controller-owned). Declared here so the
 * RepoOwner readiness contract can require the tool the base must provide —
 * a missing/broken base entry fails the dispatch instead of reaching the
 * model as a silently reduced child.
 */
export const WEB_SEARCH_ENTRY_ID = "web-search";

/**
 * The RepoOwner readiness contract — the canonical declared default for the
 * entry id -> required tools mapping, owned here (the controller's profile
 * contract), never by the capability extensions themselves.
 *
 * Workspace spawns declare it per spawn (`SpawnOptions.readinessEntries`);
 * the controller validates the child's tool-set report against that map.
 * Capability extensions (task-workspace, reporting-bridge, subagents) declare
 * nothing — they must not know they are profiled.
 */
export const PROFILE_READINESS: Record<string, string[]> = {
	// Base profile (every child, controller-owned): web_search must be present.
	[WEB_SEARCH_ENTRY_ID]: ["web_search"],
	[TASK_WORKSPACE_ENTRY_ID]: [
		"task_status",
		"ensure_task_repo",
		"checkpoint_commit",
		"remove_task_lane",
	],
	[REPORTING_ENTRY_ID]: ["report_result"],
	[SUBAGENTS_ENTRY_ID]: ["subagent"],
};

/**
 * What the probe reports: the protocol marker and the full tool set visible
 * in the child session at session_start. No entry ids, no verdicts — the
 * controller owns the contract and derives missing tools itself.
 */
export interface ReadinessPayload {
	/** Protocol marker, always "pi-subagents-readiness". */
	protocol: string;
	/** All tool names visible in the child session at session_start. */
	tools: string[];
}

export function parseReadinessPayload(raw: string | undefined): ReadinessPayload | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<ReadinessPayload> | undefined;
		if (!parsed || parsed.protocol !== READINESS_PROTOCOL) return undefined;
		if (!Array.isArray(parsed.tools)) return undefined;
		return {
			protocol: parsed.protocol,
			tools: parsed.tools.filter((t): t is string => typeof t === "string"),
		};
	} catch {
		return undefined;
	}
}
