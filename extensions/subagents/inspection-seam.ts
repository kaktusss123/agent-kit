import type { AgentSnapshot } from "./types";

export type SubagentInspectionSource = {
	inspect: () => AgentSnapshot[];
	/** The existing agentDetailView contract, including workspace enrichment. */
	view: (snapshot: AgentSnapshot) => Record<string, unknown>;
};

let source: SubagentInspectionSource | undefined;

/** Internal read seam: the inspection extension observes the live owner runtime. */
export function setSubagentInspectionSource(next: SubagentInspectionSource | undefined): void {
	source = next;
}

export function inspectSubagents(): Record<string, unknown>[] {
	return source ? source.inspect().map(source.view) : [];
}
