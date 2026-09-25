/**
 * Cross-graph integration: the registry must be shared across REAL separate
 * jiti module graphs. Pi loads every extension entry through its own fresh
 * jiti instance with `moduleCache: false` (node runtime, tryNative off), so
 * `extensions/subagents/index.ts` and `extensions/inspection-channel/index.ts`
 * each evaluate their own copy of the seam module. Module-level state would
 * fork per graph; only globalThis-backed state crosses this boundary.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

// Resolve the exact jiti copy pi itself loads extensions with.
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti", { paths: [path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent")] });
const { createJiti } = (await import(jitiPath)) as typeof import("jiti");

const seamPath = path.join(repoRoot, "extensions/subagents/inspection-seam.ts");
const channelPath = path.join(repoRoot, "extensions/inspection-channel/index.ts");

type JitiGraph = ReturnType<typeof createJiti>;
type SeamModule = typeof import("../../subagents/inspection-seam");

function fakeSnapshot(id: string): import("../../subagents/types").AgentSnapshot {
	return { id, label: id, state: "running", task: "probe", cwd: repoRoot, alive: true, startedAt: 0, lastActivityAt: 0, elapsedMs: 0 };
}

/** A fresh top-level module graph, the same way pi loads one extension entry. */
function freshGraph(): JitiGraph {
	return createJiti(import.meta.url, { moduleCache: false, tryNative: false });
}

async function registerMarker(graph: JitiGraph, marker: string): Promise<SeamModule> {
	const seam = (await graph.import(seamPath)) as SeamModule;
	seam.setSubagentInspectionSource({
		inspect: () => [fakeSnapshot(marker)],
		view: (snapshot) => ({ ...snapshot, via: marker }),
	});
	return seam;
}

async function snapshotAgents(channel: { handleInspectionRequest: (raw: string, deps: { cwd: string }) => Promise<any> }, id: string): Promise<Record<string, unknown>[]> {
	const response = await channel.handleInspectionRequest(JSON.stringify({ v: 1, id, op: "snapshot", area: "subagents" }), { cwd: repoRoot });
	expect(response.ok).toBe(true);
	return response.result.data.agents;
}

describe("cross-graph inspection registry", () => {
	// Hygiene: this suite deliberately registers into the process-wide
	// registry; drop leftovers so later test files see an empty seam.
	afterAll(() => {
		const registry = (globalThis as { [key: symbol]: { subagents?: unknown } | undefined })[Symbol.for("agentkit.inspection")];
		if (registry) registry.subagents = undefined;
	});

	test("every jiti graph resolves to the same registry object on globalThis", async () => {
		const graph1 = freshGraph();
		const graph2 = freshGraph();
		const seam1 = (await graph1.import(seamPath)) as SeamModule;
		const seam2 = (await graph2.import(seamPath)) as SeamModule;
		// Separate graphs produce separate module instances...
		expect(seam1).not.toBe(seam2);
		// ...but they share one process-wide registry object.
		expect(seam1.inspectionRegistry).toBe(seam2.inspectionRegistry);
		expect((globalThis as Record<symbol, unknown>)[seam1.INSPECTION_REGISTRY_KEY]).toBe(seam1.inspectionRegistry);
	});

	// Regression for the proven Pi 0.87.1 failure: with per-module state, a
	// marker registered by the subagents graph was invisible to the
	// inspection-channel graph (snapshot returned agents: []).
	test("registration in one graph is visible to a fresh channel graph; stale unregister loses to a newer graph", async () => {
		const graph1 = freshGraph();
		const graph2 = freshGraph();
		const graph3 = freshGraph();

		const seam1 = await registerMarker(graph1, "marker-A");
		// No inherited fd env is set, so the channel transport stays inert;
		// handleInspectionRequest falls through to the globalThis-backed seam.
		const channel = (await graph2.import(channelPath)) as { handleInspectionRequest: (raw: string, deps: { cwd: string }) => Promise<any> };
		const registry = (globalThis as { [key: symbol]: { channel?: unknown } | undefined })[Symbol.for("agentkit.inspection")];
		expect(registry?.channel).toBeUndefined();
		expect(await snapshotAgents(channel, "req-1")).toEqual([{ ...fakeSnapshot("marker-A"), via: "marker-A" }]);

		// A newer graph registers; then the old graph shuts its session down.
		const seam3 = await registerMarker(graph3, "marker-B");
		await seam1.setSubagentInspectionSource(undefined);
		expect(await snapshotAgents(channel, "req-2")).toEqual([{ ...fakeSnapshot("marker-B"), via: "marker-B" }]);

		// The owning graph clears: registry returns to empty.
		await seam3.setSubagentInspectionSource(undefined);
		expect(await snapshotAgents(channel, "req-3")).toEqual([]);
	});

	test("stale unregister from a graph that never registered is a no-op", async () => {
		const graph1 = freshGraph();
		const graph2 = freshGraph();
		const seam1 = await registerMarker(graph1, "marker-A");
		const bystander = (await graph2.import(seamPath)) as SeamModule;
		await bystander.setSubagentInspectionSource(undefined);
		expect(seam1.inspectSubagents()).toEqual([{ ...fakeSnapshot("marker-A"), via: "marker-A" }]);
		// Leave the process-wide registry empty for other test files.
		await seam1.setSubagentInspectionSource(undefined);
	});
});
