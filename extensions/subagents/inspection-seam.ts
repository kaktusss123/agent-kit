import type * as fs from "node:fs";
import type { AgentSnapshot } from "./types";

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
export type InspectionRegistry = {
	channel?: { input: fs.ReadStream; output: fs.WriteStream };
	cwd: string;
	subagents?: { owner: unknown; source: SubagentInspectionSource };
};

export const INSPECTION_REGISTRY_KEY = Symbol.for("agentkit.inspection");
const globalScope = globalThis as { [key: symbol]: InspectionRegistry | undefined };
export const inspectionRegistry: InspectionRegistry = (globalScope[INSPECTION_REGISTRY_KEY] ??= { cwd: process.cwd() });

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
