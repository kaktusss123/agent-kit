/**
 * Contract tests for `agent-kit-inspection`, the ZIP v1 provider.
 *
 * The ZIP wire, the FD transport, and the bridge all belong to the controller
 * (ZAVOD). Everything under test here is this extension's half: the hello body
 * it publishes into the bridge registry, the payload of every capability it
 * announces, and its inertness when there is nothing to attach to. The bridge
 * registry is therefore simulated in-process with the same API the real one
 * exposes (`{version, register, unregister, providers}` on a registered
 * symbol), which is exactly the surface the provider is allowed to use.
 */
import { after, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "../../tests/support/expect.ts";
import {
	INSPECTION_ABI_VERSION,
	inspectionRegistry,
} from "../subagents/inspection-seam.ts";
import {
	clearTaskWorkspaceInspectionSurface,
	markTaskWorkspaceInspectionSurface,
} from "../task-workspace/inspection-surface.ts";
import {
	BRIDGE_REGISTRY_KEY,
	BRIDGE_REGISTRY_VERSION,
	PROVIDER_ID,
	bindInspectionSession,
	clearInspectionSession,
	findBridgeRegistry,
	registerInspectionProvider,
	type BridgeProvider,
	type BridgeRegistry,
	type BridgeScope,
	type SubagentSource,
	type TaskWorkspaceSource,
} from "./index.ts";
import registerExtension from "./index.ts";
import { resolveProviderIdentity } from "./identity.ts";
import type { CurrentTaskProjection } from "../task-workspace/current.ts";

const TEST_IDENTITY = { adapterVersion: "agent-kit@test", buildRevision: "a".repeat(40) };

/** The bridge registry as the provider sees it: idempotent per id, token-owned. */
class FakeBridgeRegistry implements BridgeRegistry {
	readonly version: number;
	readonly entries = new Map<string, { provider: BridgeProvider; owner: object }>();

	constructor(version = BRIDGE_REGISTRY_VERSION) {
		this.version = version;
	}

	register(provider: BridgeProvider): unknown {
		const owner = {};
		this.entries.set(provider.id, { provider, owner });
		return { id: provider.id, owner };
	}

	unregister(token: unknown): boolean {
		const candidate = token as { id?: unknown; owner?: unknown } | undefined;
		if (typeof candidate?.id !== "string") return false;
		const entry = this.entries.get(candidate.id);
		if (!entry || entry.owner !== candidate.owner) return false;
		this.entries.delete(candidate.id);
		return true;
	}

	providers(): unknown[] {
		return [...this.entries.values()].map(({ provider }) => ({
			id: provider.id,
			adapterVersion: provider.adapterVersion,
			buildRevision: provider.buildRevision,
			capabilities: provider.capabilities.map((capability) => ({ ...capability })),
		}));
	}

	provider(): BridgeProvider {
		const entry = this.entries.get(PROVIDER_ID);
		if (!entry) throw new Error("provider is not registered");
		return entry.provider;
	}
}

function scopeWith(registry: unknown): BridgeScope {
	const scope: BridgeScope = {};
	scope[BRIDGE_REGISTRY_KEY] = registry;
	return scope;
}

function fakeSubagents(agents: Record<string, unknown>[], loaded = true): SubagentSource {
	return { loaded: () => loaded, agents: () => agents };
}

function fakeTaskWorkspace(projection: Record<string, unknown>, loaded = true): TaskWorkspaceSource {
	return { loaded: () => loaded, current: async () => projection as unknown as CurrentTaskProjection };
}

/** One `agentDetailView` record, plus the local process details v1 must drop. */
function agentView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "a1",
		label: "child-a",
		state: "running",
		task: "inspect the repository",
		cwd: "/home/user/private/checkout",
		thinking: "high",
		model: "openai-codex/gpt-6.1-sol",
		alive: true,
		pid: 4242,
		startedAt: 1_700_000_000_000,
		endedAt: undefined,
		lastActivityAt: 1_700_000_001_000,
		elapsedMs: 1_000,
		sessionFile: "/home/user/.pi/agent/sessions/child.jsonl",
		sessionId: "child-session",
		stats: { tokens: { input: 11, output: 7, total: 18, cacheRead: 3, cacheWrite: 2 }, cost: 0.25 },
		...overrides,
	};
}

function currentProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		state: "ok",
		identity: "feat/thing",
		workspace: "/home/user/.agent-kit/tasks/feat_thing",
		source: "session",
		repos: [
			{
				name: "agent-kit",
				path: "/home/user/.agent-kit/tasks/feat_thing/agent-kit",
				kind: "canonical",
				slot: null,
				classification: "MANAGED_TASK_WORKTREE",
				branch: "feat/thing",
				detached: false,
				headSha: "b".repeat(40),
				upstream: "origin/feat/thing",
				dirty: { staged: [], unstaged: [], available: true },
				gitAvailable: true,
				owners: [{ id: "a1", label: "child-a", state: "running" }],
			},
		],
		...overrides,
	};
}

function registeredProvider(registry: FakeBridgeRegistry, deps: Parameters<typeof registerInspectionProvider>[0] = {}): BridgeProvider {
	const registration = registerInspectionProvider({
		scope: scopeWith(registry),
		identity: TEST_IDENTITY,
		subagents: fakeSubagents([agentView()]),
		taskWorkspace: fakeTaskWorkspace(currentProjection()),
		...(deps ?? {}),
	});
	if (!registration) throw new Error("registration was refused");
	return registration.provider;
}

// The seam and the task-workspace surface are process-wide by design; every
// test that touches them restores the previous state.
const priorSubagents = inspectionRegistry.subagents;
const priorAbiVersion = inspectionRegistry.abiVersion;
after(() => {
	inspectionRegistry.subagents = priorSubagents;
	(inspectionRegistry as { abiVersion: number }).abiVersion = priorAbiVersion;
	clearInspectionSession();
	clearTaskWorkspaceInspectionSurface();
	delete (globalThis as Record<symbol, unknown>)[BRIDGE_REGISTRY_KEY];
});

describe("hello: provider identity and capabilities", () => {
	test("registers exactly the capabilities whose sources are loaded in this process", () => {
		const registry = new FakeBridgeRegistry();
		registeredProvider(registry);
		expect(registry.providers()).toEqual([
			{
				id: PROVIDER_ID,
				adapterVersion: "agent-kit@test",
				buildRevision: "a".repeat(40),
				capabilities: [
					{ name: "children.snapshot", version: 1 },
					{ name: "children.historyRef", version: 1 },
					{ name: "usage.children", version: 1 },
					{ name: "background.status", version: 1 },
					{ name: "taskWorkspace.current", version: 1 },
				],
			},
		]);
	});

	test("announces no Core capability when the Core subagent seam is not loaded", () => {
		const registry = new FakeBridgeRegistry();
		registeredProvider(registry, { subagents: fakeSubagents([], false) });
		// The provider itself is still present: "inspector loaded, Core absent"
		// must be observable instead of looking like a missing package.
		expect(registry.providers()).toEqual([
			{
				id: PROVIDER_ID,
				adapterVersion: "agent-kit@test",
				buildRevision: "a".repeat(40),
				capabilities: [{ name: "taskWorkspace.current", version: 1 }],
			},
		]);
	});

	test("announces no taskWorkspace capability when task-workspace is not loaded", () => {
		const registry = new FakeBridgeRegistry();
		registeredProvider(registry, { taskWorkspace: fakeTaskWorkspace(currentProjection(), false) });
		const provider = registry.provider();
		expect(provider.capabilities.map((capability) => capability.name)).toEqual([
			"children.snapshot",
			"children.historyRef",
			"usage.children",
			"background.status",
		]);
	});

	test("announces nothing at all when neither source is loaded, and still registers", () => {
		const registry = new FakeBridgeRegistry();
		registeredProvider(registry, {
			subagents: fakeSubagents([], false),
			taskWorkspace: fakeTaskWorkspace(currentProjection(), false),
		});
		expect(registry.provider().capabilities).toEqual([]);
	});

	test("identity comes from real files, never from a hard-coded version", () => {
		const identity = resolveProviderIdentity(path.join(import.meta.dirname));
		expect(identity.buildRevision).toMatch(/^[0-9a-f]{40}$/);
		expect(identity.adapterVersion).toBe(`agent-kit@${identity.buildRevision!.slice(0, 12)}`);
	});
});

describe("capability payloads", () => {
	test("children.snapshot carries lifecycle fields only, with a clipped summary", async () => {
		const registry = new FakeBridgeRegistry();
		const longTask = "x".repeat(250);
		const provider = registeredProvider(registry, {
			subagents: fakeSubagents([
				agentView({ task: longTask }),
				// No id: cannot be correlated with anything, so it is dropped.
				agentView({ id: undefined }),
			]),
		});
		const data = (await provider.snapshot("children.snapshot", 1, "gen-1")) as { agents: Record<string, unknown>[] };
		expect(data.agents).toHaveLength(1);
		expect(data.agents[0]).toEqual({
			id: "a1",
			label: "child-a",
			state: "running",
			startedAt: 1_700_000_000_000,
			finishedAt: null,
			sessionId: "child-session",
			sessionFile: "/home/user/.pi/agent/sessions/child.jsonl",
			model: "openai-codex/gpt-6.1-sol",
			alive: true,
			summary: `${"x".repeat(200)}…`,
		});
		// The local process details of the Core view never reach the wire.
		for (const leaked of ["cwd", "pid", "task", "thinking", "stats", "lastActivityAt", "elapsedMs"]) {
			expect(Object.hasOwn(data.agents[0], leaked)).toBe(false);
		}
	});

	test("children.snapshot omits sessionFile when Core has none", async () => {
		const registry = new FakeBridgeRegistry();
		const provider = registeredProvider(registry, { subagents: fakeSubagents([agentView({ sessionFile: undefined, endedAt: 1_700_000_009_000 })]) });
		const data = (await provider.snapshot("children.snapshot", 1, "gen-1")) as { agents: Record<string, unknown>[] };
		expect(Object.hasOwn(data.agents[0], "sessionFile")).toBe(false);
		expect(data.agents[0].finishedAt).toBe(1_700_000_009_000);
	});

	test("children.historyRef lists only bindings verified to exist right now", async () => {
		const registry = new FakeBridgeRegistry();
		const exiting = "/tmp/agent-kit-inspection-exists.jsonl";
		const missing = "/tmp/agent-kit-inspection-missing.jsonl";
		const seen: string[] = [];
		const provider = registeredProvider(registry, {
			subagents: fakeSubagents([
				agentView({ id: "a1", sessionFile: exiting }),
				agentView({ id: "a2", sessionFile: missing }),
				agentView({ id: "a3", sessionFile: undefined }),
				// A probe that throws is a failed verification, not a hit.
				agentView({ id: "a4", sessionFile: "/tmp/agent-kit-inspection-throws.jsonl" }),
			]),
			sessionFileExists: (target: string) => {
				seen.push(target);
				if (target.endsWith("throws.jsonl")) throw new Error("EACCES");
				return target === exiting;
			},
		});
		const data = (await provider.snapshot("children.historyRef", 1, "gen-1")) as { agents: unknown[] };
		expect(data.agents).toEqual([{ id: "a1", sessionFile: exiting }]);
		expect(seen).toEqual([exiting, missing, "/tmp/agent-kit-inspection-throws.jsonl"]);
	});

	test("children.historyRef verifies real files with the default probe", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-inspection-history-"));
		try {
			const present = path.join(dir, "child.jsonl");
			fs.writeFileSync(present, "{}\n");
			const registry = new FakeBridgeRegistry();
			const provider = registeredProvider(registry, {
				subagents: fakeSubagents([agentView({ id: "a1", sessionFile: present }), agentView({ id: "a2", sessionFile: path.join(dir, "gone.jsonl") })]),
			});
			const data = (await provider.snapshot("children.historyRef", 1, "gen-1")) as { agents: unknown[] };
			expect(data.agents).toEqual([{ id: "a1", sessionFile: present }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("usage.children reports per-child numbers and explicit unknowns, never a fake zero", async () => {
		const registry = new FakeBridgeRegistry();
		const provider = registeredProvider(registry, {
			subagents: fakeSubagents([
				agentView({ id: "a1" }),
				agentView({ id: "a2", stats: undefined }),
				agentView({ id: "a3", stats: { tokens: { input: 0, output: 0, total: 0 } } }),
			]),
		});
		const data = (await provider.snapshot("usage.children", 1, "gen-1")) as { agents: Record<string, unknown>[] };
		expect(data.agents).toEqual([
			{
				id: "a1",
				tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 18 },
				costUsd: 0.25,
				costKind: "reported",
			},
			{
				id: "a2",
				tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
				costUsd: null,
				costKind: "unknown",
			},
			{
				id: "a3",
				tokens: { input: 0, output: 0, cacheRead: null, cacheWrite: null, total: 0 },
				costUsd: null,
				costKind: "unknown",
			},
		]);
	});

	test("background.status is active for a live child and idle only with observed finished children", async () => {
		const live = new FakeBridgeRegistry();
		expect(await registeredProvider(live).snapshot("background.status", 1, "gen-1")).toEqual({ state: "active" });

		const finished = new FakeBridgeRegistry();
		const idleProvider = registeredProvider(finished, {
			subagents: fakeSubagents([agentView({ alive: false, endedAt: 1_700_000_005_000 })]),
		});
		expect(await idleProvider.snapshot("background.status", 1, "gen-1")).toEqual({ state: "idle" });

		const none = new FakeBridgeRegistry();
		const emptyProvider = registeredProvider(none, { subagents: fakeSubagents([]) });
		expect(await emptyProvider.snapshot("background.status", 1, "gen-1")).toEqual({ state: "idle" });
	});

	test("taskWorkspace.current projects the session selection without RepoOwner refs", async () => {
		const registry = new FakeBridgeRegistry();
		const provider = registeredProvider(registry);
		const data = await provider.snapshot("taskWorkspace.current", 1, "gen-1");
		expect(data).toEqual({
			state: "ok",
			repos: [
				{
					name: "agent-kit",
					path: "/home/user/.agent-kit/tasks/feat_thing/agent-kit",
					branch: "feat/thing",
					classification: "MANAGED_TASK_WORKTREE",
					slot: null,
					headSha: "b".repeat(40),
				},
			],
		});
	});

	test("taskWorkspace.current keeps none and missing states distinct and empty", async () => {
		const registry = new FakeBridgeRegistry();
		const noneProvider = registeredProvider(registry, {
			taskWorkspace: fakeTaskWorkspace({ state: "none", identity: null, workspace: null, source: null, repos: [] }),
		});
		expect(await noneProvider.snapshot("taskWorkspace.current", 1, "gen-1")).toEqual({ state: "none", repos: [] });

		const missingProvider = registeredProvider(new FakeBridgeRegistry(), {
			taskWorkspace: fakeTaskWorkspace({ state: "missing", identity: "feat/thing", workspace: "/gone", source: "session", repos: [{ name: "x", path: "/gone/x", kind: "canonical", slot: null, classification: "MANAGED_TASK_WORKTREE", branch: "feat/thing", detached: false, headSha: null, upstream: null, dirty: { staged: [], unstaged: [], available: false }, gitAvailable: false, owners: [] }] }),
		});
		expect(await missingProvider.snapshot("taskWorkspace.current", 1, "gen-1")).toEqual({ state: "missing", repos: [] });
	});
});

describe("feature negotiation and failures", () => {
	test("a foreign feature version is refused instead of being served", async () => {
		const provider = registeredProvider(new FakeBridgeRegistry());
		await expect(provider.snapshot("children.snapshot", 2, "gen-1")).rejects.toMatchObject({ code: "incompatible_version" });
		await expect(provider.snapshot("taskWorkspace.current", 2, "gen-1")).rejects.toMatchObject({ code: "incompatible_version" });
	});

	test("an undeclared feature is refused", async () => {
		const provider = registeredProvider(new FakeBridgeRegistry());
		await expect(provider.snapshot("children.spawn", 1, "gen-1")).rejects.toMatchObject({ code: "unsupported_feature" });
	});

	test("a capability whose source disappeared fails as provider_not_ready", async () => {
		const registry = new FakeBridgeRegistry();
		const provider = registeredProvider(registry);
		// Core and task-workspace unload while the bridge still holds the entry.
		inspectionRegistry.subagents = undefined;
		clearTaskWorkspaceInspectionSurface();
		try {
			const defaultProvider = registeredProvider(new FakeBridgeRegistry(), { subagents: undefined, taskWorkspace: undefined });
			expect(defaultProvider.capabilities).toEqual([]);
			await expect(defaultProvider.snapshot("children.snapshot", 1, "gen-1")).rejects.toMatchObject({ code: "provider_not_ready" });
		} finally {
			inspectionRegistry.subagents = priorSubagents;
		}
		// A declared capability stays routed to its (injected) source.
		expect(await provider.snapshot("children.snapshot", 1, "gen-1")).toBeDefined();
	});

	test("source errors surface as ordinary failures the bridge reports as snapshot_failed", async () => {
		const provider = registeredProvider(new FakeBridgeRegistry(), {
			subagents: {
				loaded: () => true,
				agents: () => {
					throw new Error("runtime exploded");
				},
			},
		});
		await expect(provider.snapshot("children.snapshot", 1, "gen-1")).rejects.toThrow("runtime exploded");
	});
});

describe("inertness", () => {
	test("no bridge registry in the process: nothing is registered and nothing is created", () => {
		const scope: BridgeScope = {};
		const registration = registerInspectionProvider({ scope, identity: TEST_IDENTITY });
		expect(registration).toBeUndefined();
		expect(scope[BRIDGE_REGISTRY_KEY]).toBeUndefined();
	});

	test("an incompatible registry version is ignored as if there were no bridge", () => {
		const registry = new FakeBridgeRegistry(BRIDGE_REGISTRY_VERSION + 1);
		expect(findBridgeRegistry(scopeWith(registry))).toBeUndefined();
		expect(registerInspectionProvider({ scope: scopeWith(registry), identity: TEST_IDENTITY })).toBeUndefined();
		expect(registry.entries.size).toBe(0);
	});

	test("a registry with the wrong shape is ignored", () => {
		expect(findBridgeRegistry(scopeWith({ version: BRIDGE_REGISTRY_VERSION, register: "nope" }))).toBeUndefined();
		expect(findBridgeRegistry(scopeWith(null))).toBeUndefined();
		expect(findBridgeRegistry(scopeWith("registry"))).toBeUndefined();
	});

	test("a refused registration is a no-op instead of an error", () => {
		const registry = new FakeBridgeRegistry();
		registry.register = () => null;
		expect(registerInspectionProvider({ scope: scopeWith(registry), identity: TEST_IDENTITY })).toBeUndefined();
	});

	test("a throwing registry never reaches the Pi session", () => {
		const registry = new FakeBridgeRegistry();
		registry.register = () => {
			throw new Error("registry is broken");
		};
		expect(registerInspectionProvider({ scope: scopeWith(registry), identity: TEST_IDENTITY })).toBeUndefined();
	});
});

describe("registration lifecycle", () => {
	test("re-registration replaces the entry and an old token cannot remove the new one", () => {
		const registry = new FakeBridgeRegistry();
		const scope = scopeWith(registry);
		const first = registerInspectionProvider({ scope, identity: TEST_IDENTITY, subagents: fakeSubagents([agentView()]) });
		const second = registerInspectionProvider({ scope, identity: TEST_IDENTITY, subagents: fakeSubagents([agentView()]) });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(registry.entries.size).toBe(1);
		expect(registry.unregister(first!.token)).toBe(false);
		expect(registry.entries.size).toBe(1);
		expect(registry.unregister(second!.token)).toBe(true);
		expect(registry.entries.size).toBe(0);
	});

	test("the factory registers without any model surface and re-registers per session_start", () => {
		const registry = new FakeBridgeRegistry();
		(globalThis as Record<symbol, unknown>)[BRIDGE_REGISTRY_KEY] = registry;
		const { pi, fire, refused } = fakePi();
		inspectionRegistry.subagents = {
			owner: {},
			source: { inspect: () => [], view: (snapshot) => ({ ...snapshot }) },
		};
		markTaskWorkspaceInspectionSurface();
		try {
			registerExtension(pi);
			// A24: no tool, command, shortcut, flag, or provider registration.
			expect(refused).toEqual([]);
			expect(registry.entries.size).toBe(1);
			const firstEntry = registry.entries.get(PROVIDER_ID)!;
			expect(firstEntry.provider.capabilities).toHaveLength(5);

			fire("session_start", { type: "session_start", reason: "reload" }, { cwd: os.tmpdir(), sessionManager: { getBranch: () => [] } });
			const secondEntry = registry.entries.get(PROVIDER_ID)!;
			expect(secondEntry).not.toBe(firstEntry);
			expect(registry.unregister({ id: PROVIDER_ID, owner: firstEntry.owner })).toBe(false);

			// The registration belongs to the generation, not to a session:
			// shutdown must not withdraw it.
			fire("session_shutdown", { type: "session_shutdown" });
			expect(registry.entries.has(PROVIDER_ID)).toBe(true);
			expect(registry.unregister({ id: PROVIDER_ID, owner: secondEntry.owner })).toBe(true);
		} finally {
			delete (globalThis as Record<symbol, unknown>)[BRIDGE_REGISTRY_KEY];
			inspectionRegistry.subagents = priorSubagents;
			clearInspectionSession();
			clearTaskWorkspaceInspectionSurface();
		}
	});

	test("the factory stays silent without a bridge", () => {
		delete (globalThis as Record<symbol, unknown>)[BRIDGE_REGISTRY_KEY];
		const { pi, fire, refused } = fakePi();
		registerExtension(pi);
		fire("session_start", { type: "session_start", reason: "startup" }, { cwd: os.tmpdir(), sessionManager: { getBranch: () => [] } });
		fire("session_shutdown", { type: "session_shutdown" });
		expect(refused).toEqual([]);
	});
});

describe("Core seam usage", () => {
	test("the provider reads the Core seam only when its ABI version matches", () => {
		const registry = new FakeBridgeRegistry();
		inspectionRegistry.subagents = {
			owner: {},
			source: { inspect: () => [], view: (snapshot) => ({ ...snapshot }) },
		};
		(inspectionRegistry as { abiVersion: number }).abiVersion = INSPECTION_ABI_VERSION + 1;
		try {
			// A seam shape this adapter does not know is treated as "Core not
			// observable": no children capability, no guessed reads.
			const provider = registeredProvider(registry, { subagents: undefined });
			expect(provider.capabilities.map((capability) => capability.name)).toEqual(["taskWorkspace.current"]);
		} finally {
			(inspectionRegistry as { abiVersion: number }).abiVersion = INSPECTION_ABI_VERSION;
			inspectionRegistry.subagents = priorSubagents;
		}
	});

	test("the default task-workspace source reads the bound session branch", async () => {
		const registry = new FakeBridgeRegistry();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-inspection-root-"));
		const previousRoot = process.env.AGENT_TASK_ROOT;
		process.env.AGENT_TASK_ROOT = root;
		markTaskWorkspaceInspectionSurface();
		bindInspectionSession(os.tmpdir(), {
			getBranch: () => [{ type: "custom", customType: "task-workspace.current", data: { task: "feat/vanished" } }],
		});
		try {
			const registration = registerInspectionProvider({ scope: scopeWith(registry), identity: TEST_IDENTITY, subagents: fakeSubagents([], false) });
			expect(registration?.provider.capabilities).toEqual([{ name: "taskWorkspace.current", version: 1 }]);
			// The selection is recorded in the session history, but its workspace
			// is gone: `missing`, never a fabricated `ok`.
			expect(await registration!.provider.snapshot("taskWorkspace.current", 1, "gen-1")).toEqual({ state: "missing", repos: [] });
		} finally {
			if (previousRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
			clearInspectionSession();
			clearTaskWorkspaceInspectionSurface();
		}
	});

	test("without a bound session the default source reports none instead of the process cwd", async () => {
		const registry = new FakeBridgeRegistry();
		markTaskWorkspaceInspectionSurface();
		clearInspectionSession();
		try {
			const registration = registerInspectionProvider({ scope: scopeWith(registry), identity: TEST_IDENTITY, subagents: fakeSubagents([], false) });
			expect(await registration!.provider.snapshot("taskWorkspace.current", 1, "gen-1")).toEqual({ state: "none", repos: [] });
		} finally {
			clearTaskWorkspaceInspectionSurface();
		}
	});
});

describe("process boundaries", () => {
	test("the provider never shells out to the agent-kit CLI or any subprocess", () => {
		for (const file of ["index.ts", "features.ts", "identity.ts"]) {
			const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
			for (const forbidden of ["node:child_process", "execFile", "execSync", "spawn(", "agent-kit task"]) {
				expect(source.includes(forbidden)).toBe(false);
			}
		}
	});
});

/** A Pi API stand-in: it records the registration calls A24 forbids. */
function fakePi(): {
	pi: never;
	fire: (event: string, ...args: unknown[]) => void;
	refused: string[];
} {
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const refused: string[] = [];
	const refuse = (name: string) => () => {
		refused.push(name);
		throw new Error(`unexpected ${name} registration`);
	};
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: refuse("registerTool"),
		registerCommand: refuse("registerCommand"),
		registerShortcut: refuse("registerShortcut"),
		registerFlag: refuse("registerFlag"),
		registerProvider: refuse("registerProvider"),
	};
	return {
		pi: api as never,
		refused,
		fire: (event: string, ...args: unknown[]) => {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
}
