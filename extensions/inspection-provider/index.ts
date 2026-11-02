/**
 * `agent-kit-inspection` — the optional ZIP v1 provider for Agent Kit.
 *
 * ZAVOD (or any other controller) owns the inspection wire, the FD transport,
 * and the in-process provider registry. This extension owns exactly one thing:
 * translating the Agent Kit Core read-only state into ZIP v1 capabilities and
 * registering a provider into the bridge registry that the controller's Pi
 * bridge publishes on `globalThis[Symbol.for("zavod.inspection.v1")]`.
 *
 * Guarantees (the contract is `./README.md`):
 * - it registers NO model tool, NO slash command, NO prompt section, NO status
 *   line: an inspection-only extension cannot add an LLM token;
 * - it is completely inert when the bridge registry is absent or reports an
 *   incompatible version — a terminal Pi session without ZAVOD, or a node
 *   without the bridge, sees no error, no output, and no registration;
 * - capabilities are announced only for sources that are really loaded in
 *   THIS process: no Core subagents → no `children.*`/`background.status`,
 *   no task-workspace extension → no `taskWorkspace.current`;
 * - Core is read only through the versioned read-only seam
 *   (`extensions/subagents/inspection-seam.ts`) and the task-workspace
 *   projection module; no subagent mechanism is reimplemented or replaced;
 * - the provider's own code never spawns a process and never calls the
 *   `agent-kit` CLI: it lives inside the Pi process and reads in-memory state.
 *   The task-workspace projection it serves is Core's, so the Git reads behind
 *   `taskWorkspace.current` are Core's own `git` calls (see README).
 * - the Core seam module is imported only after a compatible bridge registry
 *   is found: a Pi session without a bridge must not get a Core seam registry
 *   created on its behalf.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import {
	buildCurrentTaskProjection,
	type CurrentTaskProjection,
	type SessionSelectionEntry,
} from "../task-workspace/current.ts";
import { taskWorkspaceInspectionSurfacePresent } from "../task-workspace/inspection-surface.ts";
import { resolveTaskRoot } from "../task-workspace/task-root.ts";
import {
	BACKGROUND_STATUS,
	CHILDREN_HISTORY_REF,
	CHILDREN_SNAPSHOT,
	FEATURE_VERSION,
	TASK_WORKSPACE_CURRENT,
	USAGE_CHILDREN,
	backgroundStatus,
	childrenHistoryRef,
	childrenSnapshot,
	taskWorkspaceCurrent,
	usageChildren,
	type AgentView,
} from "./features.ts";
import { resolveProviderIdentity, type ProviderIdentity } from "./identity.ts";

export const PROVIDER_ID = "agent-kit-inspection";
/** The bridge's process-wide registry key. A registered symbol: every jiti graph shares it. */
export const BRIDGE_REGISTRY_KEY = Symbol.for("zavod.inspection.v1");
export const BRIDGE_REGISTRY_VERSION = 1;

/** Capabilities served from the Core subagent seam. */
const SUBAGENT_FEATURES = [CHILDREN_SNAPSHOT, CHILDREN_HISTORY_REF, USAGE_CHILDREN, BACKGROUND_STATUS] as const;
/** Capabilities served from the task-workspace projection. */
const TASK_WORKSPACE_FEATURES = [TASK_WORKSPACE_CURRENT] as const;

export interface BridgeCapability {
	name: string;
	version: number;
}

/** A provider as the bridge registry sees it. */
export interface BridgeProvider {
	id: string;
	adapterVersion: string;
	buildRevision: string | null;
	capabilities: BridgeCapability[];
	snapshot(feature: string, featureVersion: number, generation: string): unknown;
}

/** The subset of the bridge registry this extension is allowed to use. */
export interface BridgeRegistry {
	version: number;
	register(provider: BridgeProvider): unknown;
	unregister(token: unknown): boolean;
	providers(): unknown[];
}

export type BridgeScope = { [key: symbol]: unknown };

/** Core subagent state, read through the versioned seam only. */
export interface SubagentSource {
	/** True when the Core subagent runtime is loaded in this process. */
	loaded(): boolean;
	/** Live `agentDetailView` records, one per observed child. */
	agents(): AgentView[];
}

/** Session-scoped current-task projection, read through the Core module. */
export interface TaskWorkspaceSource {
	/** True when the task-workspace extension is loaded in this process. */
	loaded(): boolean;
	current(): Promise<CurrentTaskProjection>;
}

export interface ProviderDeps {
	subagents?: SubagentSource;
	taskWorkspace?: TaskWorkspaceSource;
	/** Registry scope; default is the process globalThis. */
	scope?: BridgeScope;
	/** Identity override for tests; production resolves it from real files. */
	identity?: ProviderIdentity;
	/** Transcript existence probe; default is `fs.existsSync`. */
	sessionFileExists?: (path: string) => boolean;
}

export interface ProviderRegistration {
	token: unknown;
	provider: BridgeProvider;
}

/**
 * The bridge registry, when a compatible one is published in this process.
 * Anything else (absent, wrong version, broken shape) is the same answer: no
 * bridge, and the provider stays inert instead of guessing.
 */
export function findBridgeRegistry(scope: BridgeScope = globalThis): BridgeRegistry | undefined {
	const candidate = scope[BRIDGE_REGISTRY_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const registry = candidate as Partial<BridgeRegistry>;
	if (registry.version !== BRIDGE_REGISTRY_VERSION) return undefined;
	if (typeof registry.register !== "function" || typeof registry.unregister !== "function" || typeof registry.providers !== "function") {
		return undefined;
	}
	return registry as BridgeRegistry;
}

/** The Core seam module, loaded lazily: see `loadCoreSeam`. */
type CoreSeam = typeof import("../subagents/inspection-seam.ts");

const EMPTY_PROJECTION: CurrentTaskProjection = { state: "none", identity: null, workspace: null, source: null, repos: [] };

let coreSeam: CoreSeam | undefined;
let coreSeamLoad: Promise<CoreSeam | undefined> | undefined;

/**
 * Import the Core seam module, but only when a compatible bridge registry is
 * already attached. `inspection-seam.ts` publishes its process-wide registry
 * at import time, so importing it from a session that has no inspection
 * consumer would create state nobody reads. The load is cached per module
 * copy; a failed load is a missing Core, not an error in the session.
 */
export function loadCoreSeam(scope: BridgeScope = globalThis): Promise<CoreSeam | undefined> {
	if (!findBridgeRegistry(scope)) return Promise.resolve(undefined);
	coreSeamLoad ??= import("../subagents/inspection-seam.ts").then(
		(module) => (coreSeam = module as CoreSeam),
		() => undefined,
	);
	return coreSeamLoad;
}

/** The current session's branch reader, bound on `session_start` in this graph. */
let boundSession: { cwd: string; manager: { getBranch: () => unknown[] } } | undefined;

export function bindInspectionSession(cwd: string, manager: { getBranch: () => unknown[] }): void {
	boundSession = { cwd, manager };
}

export function clearInspectionSession(): void {
	boundSession = undefined;
}

/** Production Core subagent source: the lazily loaded seam, gated by its ABI version. */
const coreSubagents: SubagentSource = {
	loaded: () => {
		const seam = coreSeam;
		return seam !== undefined && seam.inspectionRegistry.abiVersion === seam.INSPECTION_ABI_VERSION && seam.inspectionRegistry.subagents !== undefined;
	},
	agents: () => coreSeam?.inspectSubagents() ?? [],
};

/** Production task-workspace source: the session-scoped projection. */
const coreTaskWorkspace: TaskWorkspaceSource = {
	loaded: () => taskWorkspaceInspectionSurfacePresent(),
	current: () => {
		const session = boundSession;
		// No live binding (before session_start, or after session_shutdown): the
		// process cwd is not a session selection, so never present it as current.
		if (!session) return Promise.resolve(EMPTY_PROJECTION);
		return buildCurrentTaskProjection({
			cwd: session.cwd,
			taskRoot: resolveTaskRoot(),
			branchEntries: (session.manager.getBranch() ?? []) as SessionSelectionEntry[],
			// Active RepoOwner refs are an enrichment outside capability v1.
			owners: () => [],
		});
	},
};

export function capabilitiesFor(sources: { subagents: boolean; taskWorkspace: boolean }): BridgeCapability[] {
	const capabilities: BridgeCapability[] = [];
	if (sources.subagents) {
		for (const name of SUBAGENT_FEATURES) capabilities.push({ name, version: FEATURE_VERSION });
	}
	if (sources.taskWorkspace) {
		for (const name of TASK_WORKSPACE_FEATURES) capabilities.push({ name, version: FEATURE_VERSION });
	}
	return capabilities;
}

let cachedIdentity: ProviderIdentity | undefined;

function providerIdentity(): ProviderIdentity {
	cachedIdentity ??= resolveProviderIdentity(import.meta.dirname);
	return cachedIdentity;
}

/**
 * A provider-side failure carrying the ZIP error code the bridge understands.
 * The bridge maps `provider_not_ready`/`timeout` through and reports anything
 * else as `snapshot_failed`, so a missing source and a broken source stay
 * distinguishable on the wire.
 */
function inspectionFailure(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

function readAgents(source: SubagentSource): AgentView[] {
	if (!source.loaded()) {
		throw inspectionFailure("provider_not_ready", "agent-kit core subagents are not loaded in this process");
	}
	// Source failures propagate: the bridge reports them as `snapshot_failed`.
	return source.agents() ?? [];
}

/** A capability payload: exactly the `data` body of one `snapshot` answer. */
export type FeaturePayload =
	| ReturnType<typeof childrenSnapshot>
	| ReturnType<typeof childrenHistoryRef>
	| ReturnType<typeof usageChildren>
	| ReturnType<typeof backgroundStatus>
	| ReturnType<typeof taskWorkspaceCurrent>;

/** Serve one capability payload. Exact feature version only; never a fallback. */
export async function serveFeature(
	feature: string,
	featureVersion: number,
	deps: {
		subagents: SubagentSource;
		taskWorkspace: TaskWorkspaceSource;
		sessionFileExists: (path: string) => boolean;
	},
): Promise<FeaturePayload> {
	const subagentFeature = (SUBAGENT_FEATURES as readonly string[]).includes(feature);
	const taskWorkspaceFeature = (TASK_WORKSPACE_FEATURES as readonly string[]).includes(feature);
	if (!subagentFeature && !taskWorkspaceFeature) {
		throw inspectionFailure("unsupported_feature", `${JSON.stringify(feature)} is not a ${PROVIDER_ID} capability`);
	}
	if (featureVersion !== FEATURE_VERSION) {
		throw inspectionFailure("incompatible_version", `${feature} is supported at version ${FEATURE_VERSION}, not ${featureVersion}`);
	}
	if (subagentFeature) {
		const agents = readAgents(deps.subagents);
		switch (feature) {
			case CHILDREN_SNAPSHOT:
				return childrenSnapshot(agents);
			case CHILDREN_HISTORY_REF:
				return childrenHistoryRef(agents, deps.sessionFileExists);
			case USAGE_CHILDREN:
				return usageChildren(agents);
			default:
				return backgroundStatus(agents);
		}
	}
	if (!deps.taskWorkspace.loaded()) {
		throw inspectionFailure("provider_not_ready", "the task-workspace extension is not loaded in this process");
	}
	return taskWorkspaceCurrent(await deps.taskWorkspace.current());
}

/**
 * Register the provider into the bridge registry, if this process has one.
 * Returns undefined when there is no compatible registry or the bridge refuses
 * the registration; never throws, because inspection is optional and a broken
 * registry must not break the Pi session.
 */
export function registerInspectionProvider(deps: ProviderDeps = {}): ProviderRegistration | undefined {
	const registry = findBridgeRegistry(deps.scope ?? globalThis);
	if (!registry) return undefined;
	const subagents = deps.subagents ?? coreSubagents;
	const taskWorkspace = deps.taskWorkspace ?? coreTaskWorkspace;
	const identity = deps.identity ?? providerIdentity();
	const sources = { subagents: sourceLoaded(subagents), taskWorkspace: sourceLoaded(taskWorkspace) };
	const provider: BridgeProvider = {
		id: PROVIDER_ID,
		adapterVersion: identity.adapterVersion,
		buildRevision: identity.buildRevision,
		capabilities: capabilitiesFor(sources),
		snapshot: (feature: string, featureVersion: number) =>
			serveFeature(feature, featureVersion, {
				subagents,
				taskWorkspace,
				sessionFileExists: deps.sessionFileExists ?? fs.existsSync,
			}),
	};
	let token: unknown;
	try {
		token = registry.register(provider);
	} catch {
		return undefined;
	}
	// A refused registration is null/undefined, not a token we could own.
	return token === undefined || token === null ? undefined : { token, provider };
}

function sourceLoaded(source: { loaded: () => boolean }): boolean {
	try {
		return source.loaded() === true;
	} catch {
		return false;
	}
}

/**
 * Pi extension factory.
 *
 * Registration happens at factory time (when the bridge registry is already
 * published, e.g. this extension is loaded after the bridge) and again on
 * every `session_start`, which is also the reload point: the bridge advances
 * its provider generation on each of its own factory executions and drops
 * entries from the previous generation, so `session_start` (fired after ALL
 * factories ran) is the authoritative re-registration.
 *
 * The Core seam is imported here, after a compatible registry is known to
 * exist, and never at module scope: loading this extension in a session
 * without a bridge must not create Core state.
 *
 * `session_shutdown` deliberately does NOT unregister: the registration
 * belongs to the generation, not to a session, and a stale `unregister` from
 * an old graph could only ever remove its own record.
 */
export default async function registerInspectionProviderExtension(pi: ExtensionAPI): Promise<void> {
	const register = async () => {
		try {
			// No compatible registry → no import: `loadCoreSeam` returns early.
			await loadCoreSeam();
			registerInspectionProvider();
		} catch {
			// Inspection is optional: never surface a provider problem in the session.
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		bindSessionFromContext(ctx);
		await register();
	});
	pi.on("session_shutdown", () => {
		clearInspectionSession();
	});
	await register();
}

function bindSessionFromContext(ctx: unknown): void {
	const context = ctx as { cwd?: unknown; sessionManager?: { getBranch?: unknown } } | undefined;
	const manager = context?.sessionManager;
	if (typeof context?.cwd !== "string" || !manager || typeof manager.getBranch !== "function") return;
	bindInspectionSession(context.cwd, manager as { getBranch: () => unknown[] });
}
