/**
 * Cross-graph integration: the provider must attach to the ONE process-wide
 * bridge registry, whatever module graph it was evaluated in.
 *
 * Pi loads every extension entry through its own fresh jiti instance with
 * `moduleCache: false` (node runtime, tryNative off), and reloads re-evaluate
 * them. The bridge registry, the Core seam, and the task-workspace surface
 * therefore cross module-graph boundaries only through registered symbols on
 * `globalThis`. This suite reproduces that split with real jiti graphs: the
 * bridge registry is created by the test (the real one belongs to ZAVOD), the
 * Core seam is registered by one graph, and the provider is evaluated in
 * another.
 */
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { BridgeProvider } from "./index.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// Resolve the exact jiti copy pi itself loads extensions with.
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti", { paths: [path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent")] });
const { createJiti } = (await import(jitiPath)) as typeof import("jiti");

const providerPath = path.join(repoRoot, "extensions/inspection-provider/index.ts");
const seamPath = path.join(repoRoot, "extensions/subagents/inspection-seam.ts");
const BRIDGE_KEY = Symbol.for("zavod.inspection.v1");

type JitiGraph = ReturnType<typeof createJiti>;

/** A fresh top-level module graph, the same way pi loads one extension entry. */
function freshGraph(): JitiGraph {
	return createJiti(import.meta.url, { moduleCache: false, tryNative: false });
}

/** The bridge registry as its public contract describes it (owned by ZAVOD in production). */
function bridgeRegistry() {
	const entries = new Map<string, { provider: BridgeProvider; owner: object }>();
	return {
		version: 1,
		epoch: 0,
		entries,
		register(provider: BridgeProvider) {
			const owner = {};
			entries.set(provider.id, { provider, owner });
			return { id: provider.id, owner };
		},
		unregister(token: unknown) {
			const candidate = token as { id?: unknown; owner?: unknown } | null;
			if (!candidate || typeof candidate.id !== "string") return false;
			const entry = entries.get(candidate.id);
			if (!entry || entry.owner !== candidate.owner) return false;
			entries.delete(candidate.id);
			return true;
		},
		providers() {
			return [...entries.values()].map(({ provider }) => ({
				id: provider.id,
				adapterVersion: provider.adapterVersion,
				buildRevision: provider.buildRevision,
				capabilities: provider.capabilities,
			}));
		},
	};
}

const registry = bridgeRegistry();
(globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry;

afterAll(() => {
	delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
	const seamRegistry = (globalThis as Record<symbol, unknown>)[Symbol.for("agentkit.inspection")] as { subagents?: unknown } | undefined;
	if (seamRegistry) seamRegistry.subagents = undefined;
});

function fakeSnapshot(id: string) {
	return { id, label: id, state: "running", task: "probe", cwd: repoRoot, alive: true, startedAt: 0, lastActivityAt: 0, elapsedMs: 0 };
}

describe("cross-graph inspection provider", () => {
	test("two jiti graphs resolve the same bridge registry symbol and object", async () => {
		const graph1 = freshGraph();
		const graph2 = freshGraph();
		const provider1 = (await graph1.import(providerPath)) as typeof import("./index.ts");
		const provider2 = (await graph2.import(providerPath)) as typeof import("./index.ts");
		expect(provider1).not.toBe(provider2);
		expect(provider1.BRIDGE_REGISTRY_KEY).toBe(provider2.BRIDGE_REGISTRY_KEY);
		expect(provider1.findBridgeRegistry()).toBe(provider2.findBridgeRegistry());
		expect(provider1.findBridgeRegistry()).toBe(registry);
	});

	test("a provider evaluated in one graph is served from the shared registry, and reload re-registration wins", async () => {
		const graph1 = freshGraph();
		const graph2 = freshGraph();
		const seam = (await graph1.import(seamPath)) as typeof import("../subagents/inspection-seam.ts");
		// The Core subagents entry published its seam in its own graph.
		seam.setSubagentInspectionSource({ inspect: () => [fakeSnapshot("marker-A")], view: (snapshot) => ({ ...snapshot }) });

		const first = (await graph2.import(providerPath)) as typeof import("./index.ts");
		const registration = first.registerInspectionProvider({
			identity: { adapterVersion: "agent-kit@test", buildRevision: null },
			taskWorkspace: { loaded: () => false, current: async () => neverProjection() },
		});
		expect(registration).toBeDefined();
		expect(registry.providers()).toHaveLength(1);
		// The provider graph sees the seam registered by the subagents graph.
		const hello = registry.providers()[0] as { capabilities: { name: string }[] };
		expect(hello.capabilities.map((capability) => capability.name)).toEqual([
			"children.snapshot",
			"children.historyRef",
			"usage.children",
			"background.status",
		]);
		const data = (await registry.entries.get("agent-kit-inspection")!.provider.snapshot("children.snapshot", 1, "gen-1")) as {
			agents: { id: string }[];
		};
		expect(data.agents.map((agent) => agent.id)).toEqual(["marker-A"]);

		// A reload evaluates the provider again in a third graph: one entry, new owner.
		const graph3 = freshGraph();
		const reloaded = (await graph3.import(providerPath)) as typeof import("./index.ts");
		const second = reloaded.registerInspectionProvider({
			identity: { adapterVersion: "agent-kit@test", buildRevision: null },
			taskWorkspace: { loaded: () => false, current: async () => neverProjection() },
		});
		expect(registry.entries.size).toBe(1);
		expect(registry.unregister(registration!.token)).toBe(false);
		expect(registry.unregister(second!.token)).toBe(true);
		expect(registry.entries.size).toBe(0);
	});
});

function neverProjection() {
	return { state: "none" as const, identity: null, workspace: null, source: null, repos: [] };
}
