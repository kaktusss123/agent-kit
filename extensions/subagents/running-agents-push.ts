/**
 * Running-agents push — honest runtime telemetry for an external RPC host.
 *
 * The subagents extension owns the live registry; an external controller
 * (zavod's node) needs the set of RUNNING subagents so it stops treating a Pi
 * session as idle while background children still work. The only existing
 * push channel in pi RPC mode is the fire-and-forget extension UI
 * `setStatus` request, so this module projects the registry into a bounded
 * JSON payload and emits it as `statusText` under the fixed status key
 * `agentkit:running-agents`.
 *
 * Wire contract (v1, frozen with the consumer):
 *
 *   {"type":"extension_ui_request","id":"<pi uuid>","method":"setStatus",
 *    "statusKey":"agentkit:running-agents","statusText":"<JSON string>"}
 *
 * with `statusText` = JSON of
 *
 *   {"v":1,
 *    "agents":[{"id":"sa-3-x1","label":"review","state":"running"}],
 *    "count":1,"truncated":false}
 *
 * Invariants:
 * - rows are the non-terminal registry records (`starting`, `running`,
 *   `waiting_input`) with a live process — the same records `inspect()` reads,
 *   never disk markers or guesses; a terminal record leaves the set at its
 *   transition, and a record whose process exited leaves it even when the
 *   state has not terminalized yet (a clean self-exit can beat the settle
 *   fetch and leave a stale non-terminal state behind);
 * - rows are sorted by `startedAt` then `id`, so an unchanged set always
 *   serializes identically;
 * - `count` is the TRUE running count even when rows are truncated;
 * - the serialized `statusText` never exceeds 64 KiB: earliest rows win and
 *   `truncated` flips to true (`count` stays the true count);
 * - a frame is emitted only when the set signature changes, plus the
 *   creation frame and the unconditional empty frame on shutdown;
 * - emission is gated to `ctx.mode === "rpc"` captured from session_start
 *   (TUI/print never emit — no footer noise), and every failure path is
 *   inert: a missing ctx/ui, a throwing source, or a throwing `setStatus`
 *   must never surface into extension handlers.
 */
import type { AgentState } from "./types.ts";

/** Fixed status key of the running-agents channel (wire contract v1). */
export const RUNNING_AGENTS_STATUS_KEY = "agentkit:running-agents";

/** Hard byte budget for one serialized `statusText` (64 KiB). */
export const RUNNING_AGENTS_BYTE_BUDGET = 64 * 1024;

/** Logical states that count as running (non-terminal). */
export type RunningAgentState = Extract<AgentState, "starting" | "running" | "waiting_input">;

const RUNNING_STATES: ReadonlySet<string> = new Set<RunningAgentState>([
	"starting",
	"running",
	"waiting_input",
]);

export function isRunningAgentState(state: string): state is RunningAgentState {
	return RUNNING_STATES.has(state);
}

/** Minimal registry projection the push reads (structurally an AgentSnapshot). */
export interface RunningAgentRecord {
	id: string;
	label?: string;
	state: string;
	startedAt: number;
	/**
	 * Process liveness, exactly `AgentSnapshot.alive` (`!conn.exit`). Required so
	 * every source states it: a record whose process is gone is never running,
	 * regardless of what its logical state still says.
	 */
	alive: boolean;
}

/** One wire row; exactly `id`, `label`, `state` — no extra keys. */
export interface RunningAgentRow {
	id: string;
	label: string;
	state: RunningAgentState;
}

export interface RunningAgentsFrame {
	/** JSON-encoded `statusText` payload. */
	statusText: string;
	/** TRUE number of running agents, independent of truncation. */
	count: number;
	truncated: boolean;
}

/**
 * Project live records into the sorted running set: non-terminal states with a
 * live process only, label falls back to id when empty, order by `startedAt`
 * then `id`.
 */
export function runningAgentRows(records: readonly RunningAgentRecord[]): RunningAgentRow[] {
	const rows: Array<RunningAgentRow & { startedAt: number }> = [];
	for (const record of records) {
		if (!record.alive || !isRunningAgentState(record.state)) continue;
		rows.push({
			id: record.id,
			label: typeof record.label === "string" && record.label.length > 0 ? record.label : record.id,
			state: record.state,
			startedAt: record.startedAt,
		});
	}
	rows.sort((a, b) => a.startedAt - b.startedAt || compareIds(a.id, b.id));
	return rows.map(({ startedAt: _startedAt, ...row }) => row);
}

/**
 * Serialize the frame under the byte budget. Rows must already be sorted (see
 * `runningAgentRows`); the earliest rows that fit are kept and `truncated`
 * reports whether any running row was dropped. `count` is always the true
 * running count. The returned `statusText` is measured by its UTF-8 byte
 * length, exactly what the host receives.
 */
export function formatRunningAgentsFrame(
	rows: readonly RunningAgentRow[],
	byteBudget: number = RUNNING_AGENTS_BYTE_BUDGET,
): RunningAgentsFrame {
	const count = rows.length;
	let kept: RunningAgentRow[] = [];
	for (const row of rows) {
		const candidate = [...kept, row];
		const statusText = serializeFrame(candidate, count, candidate.length < count);
		if (byteLength(statusText) > byteBudget) break;
		kept = candidate;
	}
	const truncated = kept.length < count;
	return { statusText: serializeFrame(kept, count, truncated), count, truncated };
}

/**
 * Dedup signature over the sorted running set: `[id, state, label]` per row.
 * Identical sets (including an unchanged label) produce identical signatures,
 * so the emitter never repeats a frame the host already has.
 */
export function runningAgentsSignature(rows: readonly RunningAgentRow[]): string {
	return JSON.stringify(rows.map((row) => [row.id, row.state, row.label]));
}

/** Source the push reads: the live registry plus runtime-wide change notifications. */
export interface RunningAgentsPushSource {
	/** The same records `inspect()` reads; may throw, the emitter stays inert. */
	inspect(): readonly RunningAgentRecord[];
	/** Subscribe to record mutations (spawn, state change, exit, shutdown). */
	onRecordsChanged(cb: () => void): () => void;
}

/**
 * Session context captured at `session_start`. `mode` gates the channel and
 * `ui` is the push transport; both may be absent, in which case the emitter
 * is inert.
 */
export interface RunningAgentsPushContext {
	mode?: string;
	ui?: { setStatus?(key: string, text?: string): void };
}

export interface RunningAgentsPush {
	/** Recompute from the registry; emit only when the set signature changed. */
	publish(): void;
	/**
	 * Adopt a newer session ctx (session switch) and republish. The set dedup
	 * still applies: an unchanged set emits nothing, because the transport
	 * host (the RPC controller) did not change with the session.
	 */
	updateContext(ctx: RunningAgentsPushContext): void;
	/** Unsubscribe and emit the unconditional empty frame (runtime shutdown). */
	shutdown(): void;
}

/**
 * Attach the push to a runtime. The creation frame is emitted immediately
 * (usually the empty set) so the host sees the channel live; afterwards the
 * runtime's records-changed notifications drive recomputation. Nothing here
 * throws: telemetry must never break spawn/lifecycle handlers.
 */
export function attachRunningAgentsPush(
	source: RunningAgentsPushSource,
	ctx: RunningAgentsPushContext = {},
	byteBudget: number = RUNNING_AGENTS_BYTE_BUDGET,
): RunningAgentsPush {
	let current = ctx;
	let lastSignature: string | undefined;
	let detached = false;
	const detach = source.onRecordsChanged(() => publish());

	function active(): boolean {
		return current.mode === "rpc" && typeof current.ui?.setStatus === "function";
	}

	/** Best-effort transport write; returns whether the host accepted it. */
	function emit(rows: readonly RunningAgentRow[]): boolean {
		if (!active()) return false;
		const { statusText } = formatRunningAgentsFrame(rows, byteBudget);
		try {
			current.ui!.setStatus!(RUNNING_AGENTS_STATUS_KEY, statusText);
			return true;
		} catch {
			return false;
		}
	}

	function publish(): void {
		if (!active()) return;
		let rows: RunningAgentRow[];
		try {
			rows = runningAgentRows(source.inspect());
		} catch {
			return; // a broken registry read is inert, never throws into handlers
		}
		const signature = runningAgentsSignature(rows);
		if (signature === lastSignature) return;
		// Remember the signature only after the write landed: a transient
		// transport failure must not suppress the next retry of the same set.
		if (emit(rows)) lastSignature = signature;
	}

	// Creation frame: the host learns the channel is live even when empty.
	publish();

	return {
		publish,
		updateContext(next) {
			current = next;
			publish();
		},
		shutdown() {
			if (!detached) {
				detached = true;
				detach();
			}
			lastSignature = undefined;
			// Unconditional empty frame: the host must not keep a stale count
			// after this runtime is gone. Best-effort by construction.
			emit([]);
		},
	};
}

// -------------------------------------------------------------------- helpers

function serializeFrame(rows: readonly RunningAgentRow[], count: number, truncated: boolean): string {
	return JSON.stringify({ v: 1, agents: rows, count, truncated });
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
