/**
 * ZIP v1 capability payloads for `agent-kit-inspection`.
 *
 * Input is the existing Core read-only projection — `agentDetailView` records
 * from the subagent inspection seam, and the session-scoped current-task
 * projection from `task-workspace/current.ts`. Output is the narrow, stable
 * v1 wire contract documented in `./README.md`: no child cwd, no pid, no
 * environment, no run internals, and no RepoOwner refs (that enrichment is a
 * separate, later capability, not part of v1).
 *
 * The mappings are pure functions so the contract can be tested without a
 * live Pi process, and so the only place that decides which Core field
 * becomes which wire field is this file.
 */
import type { CurrentTaskProjection } from "../task-workspace/current.ts";

/** Version of every capability this adapter implements. Exact match only. */
export const FEATURE_VERSION = 1;

export const CHILDREN_SNAPSHOT = "children.snapshot";
export const CHILDREN_HISTORY_REF = "children.historyRef";
export const USAGE_CHILDREN = "usage.children";
export const BACKGROUND_STATUS = "background.status";
export const TASK_WORKSPACE_CURRENT = "taskWorkspace.current";

/** The Core agent view: an `agentDetailView` record, fields read defensively. */
export type AgentView = Record<string, unknown>;

/** Length of the one-line summary carried in `children.snapshot`. */
const SUMMARY_LIMIT = 200;

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function clipSummary(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

export interface ChildSnapshotEntry {
	id: string;
	label: string;
	state: string;
	/** Epoch milliseconds, or null when the Core record has no value. */
	startedAt: number | null;
	/** Epoch milliseconds, or null while the child has not finished. */
	finishedAt: number | null;
	sessionId: string | null;
	/** Local session transcript path; present only when Core knows it. */
	sessionFile?: string;
	model: string | null;
	alive: boolean;
	/** The child's task prompt, clipped to `SUMMARY_LIMIT` characters. */
	summary: string;
}

/**
 * `children.snapshot` v1: identity, lifecycle state, timestamps, model, and a
 * clipped prompt. Records without a usable `id` are dropped: an unnamed child
 * cannot be correlated with anything, and inventing one would be worse.
 */
export function childrenSnapshot(agents: AgentView[]): { agents: ChildSnapshotEntry[] } {
	const entries: ChildSnapshotEntry[] = [];
	for (const agent of agents) {
		const id = asString(agent.id);
		if (!id) continue;
		const sessionFile = asString(agent.sessionFile);
		const entry: ChildSnapshotEntry = {
			id,
			label: asString(agent.label) ?? id,
			state: asString(agent.state) ?? "unknown",
			startedAt: asNumber(agent.startedAt),
			finishedAt: asNumber(agent.endedAt),
			sessionId: asString(agent.sessionId),
			model: asString(agent.model),
			alive: agent.alive === true,
			summary: clipSummary(agent.task),
		};
		if (sessionFile) entry.sessionFile = sessionFile;
		entries.push(entry);
	}
	return { agents: entries };
}

/**
 * `children.historyRef` v1: only bindings that were verified to exist right
 * now. A path that Core mentions but that is gone (retired, cleaned, another
 * host) is omitted instead of being offered as readable history.
 */
export function childrenHistoryRef(agents: AgentView[], sessionFileExists: (path: string) => boolean): { agents: { id: string; sessionFile: string }[] } {
	const entries: { id: string; sessionFile: string }[] = [];
	for (const agent of agents) {
		const id = asString(agent.id);
		const sessionFile = asString(agent.sessionFile);
		if (!id || !sessionFile) continue;
		// A throwing existence probe is a failed verification, not a hit.
		let exists = false;
		try {
			exists = sessionFileExists(sessionFile) === true;
		} catch {
			exists = false;
		}
		if (exists) entries.push({ id, sessionFile });
	}
	return { agents: entries };
}

export interface ChildUsageEntry {
	id: string;
	/** null means unknown, never zero. */
	tokens: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		total: number | null;
	};
	costUsd: number | null;
	/** `reported` when the child reported a cost, `unknown` when it did not. */
	costKind: "reported" | "estimated" | "unknown";
}

/**
 * `usage.children` v1: one row per observed child, scoped to that child only.
 * These numbers never include the parent session and are never summed here,
 * so a consumer cannot double-count by adding them to parent usage. A child
 * without stats yields nulls and `costKind: "unknown"` — a zero would claim a
 * measurement that does not exist. `estimated` is reserved for adapters that
 * derive cost from tokens; this adapter never does.
 */
export function usageChildren(agents: AgentView[]): { agents: ChildUsageEntry[] } {
	const entries: ChildUsageEntry[] = [];
	for (const agent of agents) {
		const id = asString(agent.id);
		if (!id) continue;
		const stats = agent.stats && typeof agent.stats === "object" ? (agent.stats as Record<string, unknown>) : undefined;
		const tokens = stats?.tokens && typeof stats.tokens === "object" ? (stats.tokens as Record<string, unknown>) : undefined;
		const cost = asNumber(stats?.cost);
		entries.push({
			id,
			tokens: {
				input: asNumber(tokens?.input),
				output: asNumber(tokens?.output),
				cacheRead: asNumber(tokens?.cacheRead),
				cacheWrite: asNumber(tokens?.cacheWrite),
				total: asNumber(tokens?.total),
			},
			costUsd: cost,
			costKind: cost === null ? "unknown" : "reported",
		});
	}
	return { agents: entries };
}

/**
 * `background.status` v1: `active` while at least one observed child is alive,
 * `idle` only when the source is live and observed children are all finished.
 * The absence of the capability (Core not loaded) is the "unknown" case — this
 * function is never called then, so `idle` can never mean "we did not look".
 */
export function backgroundStatus(agents: AgentView[]): { state: "active" | "idle" } {
	return { state: agents.some((agent) => agent.alive === true) ? "active" : "idle" };
}

export interface CurrentTaskRepoEntry {
	name: string;
	path: string;
	branch: string;
	classification: string;
	slot: string | null;
	headSha: string | null;
}

/**
 * `taskWorkspace.current` v1: the session-scoped selection plus the selected
 * workspace's repositories, reduced to what a consumer needs to re-verify
 * candidate read roots. Query-only fields (dirty state, upstream, detached
 * flag, kind) and active RepoOwner refs are intentionally not part of v1.
 */
export function taskWorkspaceCurrent(projection: CurrentTaskProjection): { state: string; repos: CurrentTaskRepoEntry[] } {
	const repos = projection.state === "ok" ? projection.repos : [];
	return {
		state: projection.state,
		repos: repos.map((repo) => ({
			name: repo.name,
			path: repo.path,
			// A detached HEAD has no branch name; empty means "no branch".
			branch: repo.branch,
			classification: repo.classification,
			slot: repo.slot,
			headSha: repo.headSha,
		})),
	};
}
