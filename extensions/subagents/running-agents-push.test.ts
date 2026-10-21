/**
 * Unit tests for the running-agents push module: frame formatting, running-set
 * projection, signature dedup, the 64 KiB byte budget, and the emitter
 * attachment semantics (creation frame, RPC-only gate, shutdown frame).
 *
 * Emission against the real controller registry is covered by
 * running-agents-wiring.test.ts; the wire transport itself
 * (`extension_ui_request`/setStatus) is owned by pi and pinned by the frozen
 * contract in the module doc comment.
 */
import { describe, expect, test } from "bun:test";
import {
	attachRunningAgentsPush,
	formatRunningAgentsFrame,
	isRunningAgentState,
	RUNNING_AGENTS_BYTE_BUDGET,
	RUNNING_AGENTS_STATUS_KEY,
	runningAgentRows,
	runningAgentsSignature,
	type RunningAgentRecord,
	type RunningAgentRow,
} from "./running-agents-push";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

const record = (id: string, state: string, startedAt: number, label?: string, alive = true): RunningAgentRecord => ({
	id,
	state,
	startedAt,
	alive,
	...(label !== undefined ? { label } : {}),
});

/** Fake registry source with manual change notifications. */
function makeSource(initial: RunningAgentRecord[]) {
	let records = initial;
	const listeners = new Set<() => void>();
	return {
		source: {
			inspect: () => records,
			onRecordsChanged: (cb: () => void) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
		},
		setRecords(next: RunningAgentRecord[]) {
			records = next;
		},
		notify() {
			for (const cb of [...listeners]) cb();
		},
		listenerCount: () => listeners.size,
	};
}

/** Captured setStatus writes plus parsed frames. */
function makeUi() {
	const raw: Array<{ key: string; text: string | undefined }> = [];
	const frames: Array<Record<string, unknown>> = [];
	const ui = {
		setStatus: (key: string, text?: string) => {
			raw.push({ key, text });
			frames.push(JSON.parse(text ?? "null") as Record<string, unknown>);
		},
	};
	return { ui, raw, frames };
}

const emptyFrame = { v: 1, agents: [], count: 0, truncated: false };

describe("runningAgentRows", () => {
	test("keeps only non-terminal states and sorts by startedAt then id", () => {
		const rows = runningAgentRows([
			record("b", "running", 20),
			record("a", "starting", 10),
			record("c", "completed", 5),
			record("d", "waiting_input", 50),
			record("e", "failed", 30),
			record("f", "cancelled", 40),
			record("g", "running", 10),
		]);
		expect(rows.map((r) => r.id)).toEqual(["a", "g", "b", "d"]);
		expect(rows.map((r) => r.state)).toEqual(["starting", "running", "running", "waiting_input"]);
	});

	test("label falls back to id when absent or empty; rows carry exactly id/label/state", () => {
		const rows = runningAgentRows([
			record("sa-1", "running", 1),
			record("sa-2", "running", 2, ""),
			record("sa-3", "running", 3, "review"),
		]);
		expect(rows).toEqual([
			{ id: "sa-1", label: "sa-1", state: "running" },
			{ id: "sa-2", label: "sa-2", state: "running" },
			{ id: "sa-3", label: "review", state: "running" },
		]);
		for (const row of rows) expect(Object.keys(row).sort()).toEqual(["id", "label", "state"]);
	});

	test("state guard covers exactly starting/running/waiting_input", () => {
		expect(isRunningAgentState("starting")).toBe(true);
		expect(isRunningAgentState("running")).toBe(true);
		expect(isRunningAgentState("waiting_input")).toBe(true);
		expect(isRunningAgentState("completed")).toBe(false);
		expect(isRunningAgentState("failed")).toBe(false);
		expect(isRunningAgentState("cancelled")).toBe(false);
		expect(isRunningAgentState("bogus")).toBe(false);
	});

	test("excludes non-terminal records whose process has exited", () => {
		// A clean self-exit can beat the settle fetch, leaving `state` running
		// while the process is gone — such a record must never be pushed as a
		// live agent (no row outlives its agent).
		const rows = runningAgentRows([
			record("dead-starting", "starting", 1, undefined, false),
			record("dead-running", "running", 2, undefined, false),
			record("dead-waiting", "waiting_input", 3, undefined, false),
			record("live", "running", 4),
		]);
		expect(rows).toEqual([{ id: "live", label: "live", state: "running" }]);
	});
});

describe("formatRunningAgentsFrame", () => {
	test("serializes the exact v1 shape with a true count", () => {
		const frame = formatRunningAgentsFrame([
			{ id: "sa-3-x1", label: "review", state: "running" },
			{ id: "sa-4", label: "sa-4", state: "waiting_input" },
		]);
		expect(JSON.parse(frame.statusText)).toEqual({
			v: 1,
			agents: [
				{ id: "sa-3-x1", label: "review", state: "running" },
				{ id: "sa-4", label: "sa-4", state: "waiting_input" },
			],
			count: 2,
			truncated: false,
		});
		expect(frame.count).toBe(2);
		expect(frame.truncated).toBe(false);
	});

	test("empty set serializes to the frozen empty frame", () => {
		const frame = formatRunningAgentsFrame([]);
		expect(JSON.parse(frame.statusText)).toEqual(emptyFrame);
	});

	test("keeps the earliest rows that fit, count stays true, truncated flips", () => {
		// Two ~30 KB labels plus the frame overhead exceed 64 KiB only when the
		// third row is added.
		const rows: RunningAgentRow[] = [
			{ id: "sa-1", label: "a".repeat(30000), state: "running" },
			{ id: "sa-2", label: "b".repeat(30000), state: "running" },
			{ id: "sa-3", label: "c".repeat(30000), state: "running" },
		];
		const frame = formatRunningAgentsFrame(rows);
		const parsed = JSON.parse(frame.statusText) as { agents: RunningAgentRow[]; count: number; truncated: boolean };
		expect(parsed.agents.map((r) => r.id)).toEqual(["sa-1", "sa-2"]);
		expect(parsed.count).toBe(3);
		expect(parsed.truncated).toBe(true);
		expect(frame.truncated).toBe(true);
		expect(byteLength(frame.statusText)).toBeLessThanOrEqual(RUNNING_AGENTS_BYTE_BUDGET);
	});

	test("the byte budget boundary is exact: one byte less drops the last row", () => {
		const rows: RunningAgentRow[] = [{ id: "sa-1", label: "review", state: "running" }];
		const full = formatRunningAgentsFrame(rows);
		const exact = formatRunningAgentsFrame(rows, byteLength(full.statusText));
		expect(exact.truncated).toBe(false);
		expect(JSON.parse(exact.statusText).agents).toHaveLength(1);
		const short = formatRunningAgentsFrame(rows, byteLength(full.statusText) - 1);
		expect(short.truncated).toBe(true);
		expect(short.count).toBe(1);
		expect(JSON.parse(short.statusText).agents).toEqual([]);
		expect(byteLength(short.statusText)).toBeLessThanOrEqual(byteLength(full.statusText) - 1);
	});
});

describe("runningAgentsSignature", () => {
	const rows: RunningAgentRow[] = [
		{ id: "a", label: "x", state: "running" },
		{ id: "b", label: "y", state: "waiting_input" },
	];

	test("is stable for identical rows and normalizes order", () => {
		expect(runningAgentsSignature(rows)).toBe(runningAgentsSignature([...rows]));
	});

	test("changes on id, state, or label", () => {
		const base = runningAgentsSignature(rows);
		expect(runningAgentsSignature([{ ...rows[0]!, id: "c" }, rows[1]!])).not.toBe(base);
		expect(runningAgentsSignature([{ ...rows[0]!, state: "starting" }, rows[1]!])).not.toBe(base);
		expect(runningAgentsSignature([{ ...rows[0]!, label: "z" }, rows[1]!])).not.toBe(base);
		expect(runningAgentsSignature([rows[0]!])).not.toBe(base);
	});
});

describe("attachRunningAgentsPush", () => {
	test("emits the creation frame immediately in rpc mode", () => {
		const { source } = makeSource([]);
		const { ui, raw, frames } = makeUi();
		attachRunningAgentsPush(source, { mode: "rpc", ui });
		expect(frames).toEqual([emptyFrame]);
		expect(raw[0]!.key).toBe(RUNNING_AGENTS_STATUS_KEY);
	});

	test("no emission in non-rpc modes; adopting an rpc ctx publishes once", () => {
		const { source, notify } = makeSource([record("a", "running", 1, "lab")]);
		const { ui, frames } = makeUi();
		const push = attachRunningAgentsPush(source, { mode: "tui", ui });
		notify();
		expect(frames).toEqual([]);

		push.updateContext({ mode: "rpc", ui });
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ count: 1, truncated: false });

		// Back to TUI: the gate follows the CURRENT ctx, no footer noise.
		push.updateContext({ mode: "tui", ui });
		notify();
		expect(frames).toHaveLength(1);
	});

	test("a session rebind with an unchanged set does not re-emit", () => {
		const { source } = makeSource([record("a", "running", 1, "lab")]);
		const { ui, frames } = makeUi();
		const push = attachRunningAgentsPush(source, { mode: "rpc", ui });
		expect(frames).toHaveLength(1);
		// Same set, a fresh ctx object: the signature still suppresses the frame.
		push.updateContext({ mode: "rpc", ui: makeUi().ui });
		expect(frames).toHaveLength(1);
	});

	test("inert without ui, with a throwing source, or with a throwing setStatus", () => {
		const { source } = makeSource([record("a", "running", 1)]);
		expect(() => attachRunningAgentsPush(source, { mode: "rpc" })).not.toThrow();

		const broken = {
			inspect: () => {
				throw new Error("registry read failed");
			},
			onRecordsChanged: () => () => {},
		};
		expect(() => attachRunningAgentsPush(broken, { mode: "rpc", ui: makeUi().ui })).not.toThrow();

		const throwingUi = {
			setStatus: () => {
				throw new Error("transport down");
			},
		};
		const push = attachRunningAgentsPush(source, { mode: "rpc", ui: throwingUi });
		expect(() => push.publish()).not.toThrow();
		expect(() => push.shutdown()).not.toThrow();
	});

	test("no emission when the set signature is unchanged", () => {
		const harness = makeSource([record("a", "running", 1, "lab")]);
		const { ui, frames } = makeUi();
		const push = attachRunningAgentsPush(harness.source, { mode: "rpc", ui });
		expect(frames).toHaveLength(1);

		harness.notify();
		harness.notify();
		expect(frames).toHaveLength(1);

		// A label change is a set change.
		harness.setRecords([record("a", "running", 1, "renamed")]);
		harness.notify();
		expect(frames).toHaveLength(2);
		expect((frames[1]!.agents as RunningAgentRow[])[0]!.label).toBe("renamed");

		// A state change is a set change.
		harness.setRecords([record("a", "waiting_input", 1, "renamed")]);
		harness.notify();
		expect(frames).toHaveLength(3);
		expect((frames[2]!.agents as RunningAgentRow[])[0]!.state).toBe("waiting_input");
	});

	test("terminal transitions shrink the set and trigger a frame", () => {
		const harness = makeSource([record("a", "running", 1, "one"), record("b", "running", 2, "two")]);
		const { ui, frames } = makeUi();
		attachRunningAgentsPush(harness.source, { mode: "rpc", ui });
		expect(frames[0]!.count).toBe(2);

		harness.setRecords([record("b", "running", 2, "two")]);
		harness.notify();
		expect(frames[1]).toMatchObject({ count: 1, truncated: false });
		expect((frames[1]!.agents as RunningAgentRow[]).map((r) => r.id)).toEqual(["b"]);

		harness.setRecords([]);
		harness.notify();
		expect(frames[2]).toEqual(emptyFrame);
	});

	test("process death shrinks the set while the state is still non-terminal", () => {
		const harness = makeSource([record("a", "running", 1, "one")]);
		const { ui, frames } = makeUi();
		attachRunningAgentsPush(harness.source, { mode: "rpc", ui });
		expect(frames[0]!.count).toBe(1);

		// Same logical state, dead process: the row must leave the set.
		harness.setRecords([record("a", "running", 1, "one", false)]);
		harness.notify();
		expect(frames).toHaveLength(2);
		expect(frames[1]).toEqual(emptyFrame);
	});

	test("shutdown emits an unconditional empty frame and unsubscribes", () => {
		const harness = makeSource([record("a", "running", 1)]);
		const { ui, frames } = makeUi();
		const push = attachRunningAgentsPush(harness.source, { mode: "rpc", ui });
		expect(frames).toHaveLength(1);
		expect(harness.listenerCount()).toBe(1);

		push.shutdown();
		expect(frames).toHaveLength(2);
		expect(frames[1]).toEqual(emptyFrame);
		expect(harness.listenerCount()).toBe(0);

		harness.notify();
		expect(frames).toHaveLength(2);
	});

	test("shutdown emits the empty frame even when the set was already empty", () => {
		const { source } = makeSource([]);
		const { ui, frames } = makeUi();
		const push = attachRunningAgentsPush(source, { mode: "rpc", ui });
		expect(frames).toEqual([emptyFrame]);
		push.shutdown();
		expect(frames).toEqual([emptyFrame, emptyFrame]);
	});

	test("a failed transport write does not latch the signature (retry works)", () => {
		const harness = makeSource([record("a", "running", 1, "lab")]);
		let fail = true;
		const frames: Array<Record<string, unknown>> = [];
		const ui = {
			setStatus: (_key: string, text?: string) => {
				if (fail) throw new Error("transport down");
				frames.push(JSON.parse(text ?? "null") as Record<string, unknown>);
			},
		};
		const push = attachRunningAgentsPush(harness.source, { mode: "rpc", ui });
		expect(frames).toHaveLength(0);
		fail = false;
		push.publish(); // same set: the signature was never latched
		expect(frames).toHaveLength(1);
		expect(frames[0]!.count).toBe(1);
	});
});
