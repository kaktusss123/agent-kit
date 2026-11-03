/**
 * Public read-only state contract v1 — the subagents source.
 *
 * The contract itself (discovery symbol, registry shape, exact versions,
 * reader algorithm, field tables, ownership and session rules) is documented
 * in `docs/read-only-state.md`. This module is Core's publisher for ONE of the
 * two independent sources described there; the task-workspace source is
 * published by `extensions/task-workspace/read-only-state.ts` and neither
 * source can disable the other.
 *
 * Guarantees this module owns:
 * - it publishes a record under a registered symbol, so a consumer discovers
 *   the source without importing any Core module;
 * - the record carries an exact source version; a reader that does not support
 *   that version treats the source as unavailable instead of interpreting it;
 * - a loaded source with no children is an `ok` result with an empty list,
 *   while a failing snapshot is an explicit `error` result — never an empty
 *   list and never a thrown exception;
 * - registration ownership: only the graph that published the current record
 *   may withdraw it, so a stale shutdown of an older graph cannot remove a
 *   source published by a newer graph after reload;
 * - no transport state, no streams, no spawn/steer/cancel: this is a read-only
 *   projection, and it never mutates Core runtime state.
 *
 * Pi evaluates every extension entry through a fresh jiti instance with
 * `moduleCache: false`, and `/reload` re-evaluates them, so module-level state
 * forks per graph. The registry therefore lives on `globalThis` under a
 * registered symbol that every module copy shares.
 */

/** Registry symbol. The version suffix is part of the registry's identity: a
 *  shape change publishes under a new symbol instead of reinterpreting v1. */
export const READ_ONLY_STATE_KEY = Symbol.for("agentkit.read-only-state.v1");
/** Exact registry schema version a reader must see. */
export const READ_ONLY_STATE_SCHEMA_VERSION = 1 as const;
/** Exact subagents source version a reader must see. */
export const SUBAGENTS_SOURCE_VERSION = 1 as const;

/**
 * One observed child: the `agentDetailView` projection (identity, lifecycle,
 * process facts, live stats, tool activity, last public assistant text, and
 * the compact workspace-run view for run-owned children). The field table is
 * part of the contract document; Core publishes the projection unchanged so
 * no observation the current Core surfaces are lost.
 */
export type SubagentObservation = Record<string, unknown>;

/** Result of one source read. `status` is the only discriminator. */
export type SubagentReadResult =
	| {
			status: "ok";
			/** `active` while at least one observed child reports `alive: true`. */
			activity: "active" | "idle";
			/** Empty means "loaded source, no children"; never "could not look". */
			agents: SubagentObservation[];
	  }
	| { status: "error"; error: { code: string; message: string } };

export interface SubagentSourceRecord {
	/** Exact source version; a reader requires equality with its supported one. */
	version: number;
	/** Registration owner token. Readers treat it as opaque and never compare it. */
	owner: unknown;
	read(): SubagentReadResult;
}

/** The registry as this source sees it. The sibling slot stays opaque here. */
export interface ReadOnlyStateRegistry {
	schemaVersion: number;
	subagents?: SubagentSourceRecord;
	taskWorkspace?: unknown;
}

const globalScope = globalThis as { [key: symbol]: ReadOnlyStateRegistry | undefined };

/** Identifies this module copy: only the graph that published may withdraw. */
const instanceToken: object = {};

/**
 * The shared registry, created on first use. A registry carrying a different
 * schema version is never reused and never rewritten: an incompatible ABI is
 * left alone for its own owner (and this source stays unpublished).
 */
function registryForWrite(): ReadOnlyStateRegistry | undefined {
	const existing = globalScope[READ_ONLY_STATE_KEY];
	if (existing === undefined) {
		const created: ReadOnlyStateRegistry = { schemaVersion: READ_ONLY_STATE_SCHEMA_VERSION };
		globalScope[READ_ONLY_STATE_KEY] = created;
		return created;
	}
	if (existing === null || typeof existing !== "object") return undefined;
	return existing.schemaVersion === READ_ONLY_STATE_SCHEMA_VERSION ? existing : undefined;
}

/**
 * Publish this graph's live subagent projection. The latest graph wins
 * (registration happens on every factory execution, including after `/reload`),
 * so a reloaded graph takes over the source without racing the old one.
 */
export function publishSubagentStateSource(read: () => SubagentObservation[]): void {
	const registry = registryForWrite();
	if (!registry) return;
	registry.subagents = {
		version: SUBAGENTS_SOURCE_VERSION,
		owner: instanceToken,
		read: () => readSnapshot(read),
	};
}

/**
 * Withdraw this graph's record on shutdown. A record published by a newer
 * graph is left untouched: an old session's shutdown must not delete the
 * current process source after reload or session switch.
 */
export function withdrawSubagentStateSource(): void {
	const registry = globalScope[READ_ONLY_STATE_KEY];
	if (registry && registry.subagents?.owner === instanceToken) {
		registry.subagents = undefined;
	}
}

/**
 * One read of a publisher: source failures become an explicit `error` result,
 * and a projection that is not a list is an error too — reporting "no
 * children" for a broken projection would turn unknown into a zero.
 */
function readSnapshot(read: () => SubagentObservation[]): SubagentReadResult {
	let agents: unknown;
	try {
		agents = read();
	} catch (e) {
		return { status: "error", error: { code: "snapshot_failed", message: messageOf(e) } };
	}
	if (!Array.isArray(agents)) {
		return { status: "error", error: { code: "invalid_snapshot", message: "the subagent projection is not a list" } };
	}
	const observations = agents as SubagentObservation[];
	return {
		status: "ok",
		activity: observations.some((agent) => agent?.alive === true) ? "active" : "idle",
		agents: observations,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
