import type * as fs from "node:fs";
import type { AgentSnapshot } from "./types.ts";

export type SubagentInspectionSource = {
	inspect: () => AgentSnapshot[];
	/** The existing agentDetailView contract, including workspace enrichment. */
	view: (snapshot: AgentSnapshot) => Record<string, unknown>;
};

// Pi evaluates every extension entry through a fresh jiti instance with
// `moduleCache: false`, so each entry (and each /reload re-evaluation) gets
// its own copy of this module. Module-level state would fork per graph, so
// all process-wide inspection state lives in one registry on globalThis,
// keyed by a registered symbol that every module copy shares.

/**
 * Version of this read-only seam's shape. Consumers outside the owning Core
 * extensions (for example the optional ZAVOD inspection provider) must treat
 * the registry as opaque unless `abiVersion` matches exactly: the seam is
 * versioned so a later shape change cannot be silently read as v1. Inside
 * Core the sole consumer (the inherited inspection channel) reads the same
 * copy of this module, so it never needs the version check.
 */
export const INSPECTION_ABI_VERSION = 1 as const;
export type InspectionAbiVersion = typeof INSPECTION_ABI_VERSION;

export type InspectionRegistry = {
	abiVersion: InspectionAbiVersion;
	channel?: { input: fs.ReadStream; output: fs.WriteStream };
	cwd: string;
	subagents?: { owner: unknown; source: SubagentInspectionSource };
	/** Current session's branch reader, captured by the inspection channel
	 *  on session_start (owner token: the registering channel graph) and
	 *  cleared on session_shutdown, so task inspection can reconstruct the
	 *  session-scoped current-task projection without leaking another
	 *  session's selection. */
	session?: { owner: unknown; manager: { getBranch: () => unknown[] } };
};

export const INSPECTION_REGISTRY_KEY = Symbol.for("agentkit.inspection");
const globalScope = globalThis as { [key: symbol]: InspectionRegistry | undefined };
const sharedRegistry = globalScope[INSPECTION_REGISTRY_KEY];
// A registry created by a module copy from before this field existed is an
// ABI-1 registry: label it as such instead of claiming the current version.
const sharedAbi = sharedRegistry as { abiVersion?: number } | undefined;
if (sharedAbi && typeof sharedAbi.abiVersion !== "number") sharedAbi.abiVersion = 1;
export const inspectionRegistry: InspectionRegistry =
	sharedRegistry ?? (globalScope[INSPECTION_REGISTRY_KEY] = { abiVersion: INSPECTION_ABI_VERSION, cwd: process.cwd() });

/** Identifies this module copy: only the owning graph may unregister. */
const instanceToken: object = {};

/** Internal write seam: the subagent extension publishes its live runtime. */
export function setSubagentInspectionSource(next: SubagentInspectionSource | undefined): void {
	if (next !== undefined) {
		// A newer module instance wins: any live graph registering takes over.
		inspectionRegistry.subagents = { owner: instanceToken, source: next };
	} else if (inspectionRegistry.subagents?.owner === instanceToken) {
		// An old graph's session_shutdown must not unregister a newer graph.
		inspectionRegistry.subagents = undefined;
	}
}

/** Internal read seam: the inspection extension observes the live owner runtime. */
export function inspectSubagents(): Record<string, unknown>[] {
	const source = inspectionRegistry.subagents?.source;
	return source ? source.inspect().map(source.view) : [];
}
