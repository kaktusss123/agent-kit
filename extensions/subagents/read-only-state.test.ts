/**
 * Contract tests for the published subagents read-only source
 * (`docs/read-only-state.md`, version 1): empty vs rich observations, exact
 * version gating, error vs empty, and registration ownership across a reload.
 */
import { after as afterAll, beforeEach, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as path from "node:path";

const KEY = Symbol.for("agentkit.read-only-state.v1");
const modulePath = path.join(import.meta.dirname, "read-only-state.ts");

type Record = { version: number; owner: unknown; read: () => { status: string; activity?: string; agents?: unknown[]; error?: { code: string; message: string } } };
type Registry = { schemaVersion: number; subagents?: Record; taskWorkspace?: unknown };

const source = await import(modulePath);

function registry(): Registry | undefined {
	return (globalThis as Record<symbol, unknown>)[KEY] as Registry | undefined;
}

function slot(): Record {
	const record = registry()?.subagents;
	expect(record).toBeDefined();
	return record!;
}

/** The documented reader algorithm, reduced to the subagents slot. */
function resolve(): Record | undefined {
	const candidate = registry();
	if (!candidate || typeof candidate !== "object" || candidate.schemaVersion !== 1) return undefined;
	const record = candidate.subagents;
	if (!record || typeof record !== "object" || record.version !== 1 || typeof record.read !== "function") return undefined;
	return record;
}

beforeEach(() => {
	delete (globalThis as Record<symbol, unknown>)[KEY];
});

afterAll(() => {
	delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("subagents read-only source: publication", () => {
	test("publishes an exact version and an empty ok result is a real observation", () => {
		source.publishSubagentStateSource(() => []);
		expect(registry()?.schemaVersion).toBe(1);
		expect(slot().version).toBe(1);
		expect(typeof slot().owner).toBe("object");
		expect(slot().read()).toEqual({ status: "ok", activity: "idle", agents: [] });
	});

	test("rich observations are published unchanged", () => {
		const rich = {
			id: "child-1",
			label: "owner",
			state: "running",
			alive: true,
			task: "probe",
			cwd: "/tmp/ws",
			pid: 42,
			startedAt: 1,
			lastActivityAt: 2,
			elapsedMs: 3,
			sessionFile: "/tmp/child.jsonl",
			stats: { tokens: { input: 5, output: 6, total: 11 }, cost: 0.01 },
			recentActivity: [{ name: "bash", startedAt: 1, endedAt: 2 }],
			lastAssistantText: { text: "working", updatedAt: 2 },
			run: { workspace: "/tmp/ws", state: "running", deadlineMsLeft: 10 },
		};
		source.publishSubagentStateSource(() => [rich]);
		const result = slot().read();
		expect(result.status).toBe("ok");
		expect(result.activity).toBe("active");
		// Identity, lifecycle, activity, history ref and spend all survive verbatim.
		expect(result.agents).toEqual([rich]);
	});

	test("activity is confirmed, never assumed: idle only without a live working child", () => {
		source.publishSubagentStateSource(() => [
			{ id: "a", label: "a", state: "completed", alive: false },
			{ id: "b", label: "b", state: "waiting_input", alive: true },
		]);
		expect(slot().read().activity).toBe("active");
	});

	test("a settled child kept alive for idle exit is not confirmed activity", () => {
		// Terminal state with a live process: the runtime keeps the record alive
		// until idle exit, so liveness alone would over-report background work.
		source.publishSubagentStateSource(() => [
			{ id: "done", label: "done", state: "completed", alive: true },
			{ id: "cancelled", label: "cancelled", state: "cancelled", alive: true },
		]);
		expect(slot().read()).toMatchObject({ status: "ok", activity: "idle" });
		for (const state of ["starting", "running", "waiting_input"]) {
			source.publishSubagentStateSource(() => [{ id: "x", label: "x", state, alive: true }]);
			expect(slot().read().activity).toBe("active");
		}
	});
});

describe("subagents read-only source: errors are not empty", () => {
	test("a throwing snapshot becomes an explicit error result", () => {
		source.publishSubagentStateSource(() => {
			throw new Error("runtime exploded");
		});
		const result = slot().read();
		expect(result.status).toBe("error");
		expect(result.error).toEqual({ code: "snapshot_failed", message: "runtime exploded" });
		expect(result.agents).toBeUndefined();
	});

	test("a non-list projection is an error, not zero children", () => {
		source.publishSubagentStateSource((() => ({ agents: [] })) as never);
		expect(slot().read()).toMatchObject({ status: "error", error: { code: "invalid_snapshot" } });
	});
});

describe("subagents read-only source: exact versions", () => {
	test("an unsupported source version is unavailable, never reinterpreted", () => {
		source.publishSubagentStateSource(() => [{ id: "a", label: "a", state: "running", alive: true }]);
		expect(resolve()).toBe(slot());
		slot().version = 2;
		expect(resolve()).toBeUndefined();
	});

	test("an incompatible registry schema is left alone and not written to", () => {
		const foreign = { schemaVersion: 2, marker: "foreign" };
		(globalThis as Record<symbol, unknown>)[KEY] = foreign;
		source.publishSubagentStateSource(() => []);
		expect((globalThis as Record<symbol, unknown>)[KEY]).toBe(foreign);
		expect(foreign).toEqual({ schemaVersion: 2, marker: "foreign" });
	});
});

describe("subagents read-only source: reload ownership", () => {
	test("a reloaded graph wins, and a stale shutdown cannot remove its record", async () => {
		const first = (await import(`${modulePath}?copy=first`)) as typeof source;
		const second = (await import(`${modulePath}?copy=second`)) as typeof source;
		expect(first).not.toBe(second);

		first.publishSubagentStateSource(() => [{ id: "old" }]);
		const oldOwner = slot().owner;
		second.publishSubagentStateSource(() => [{ id: "new" }]);
		const newOwner = slot().owner;
		expect(newOwner).not.toBe(oldOwner);
		expect(slot().read().agents).toEqual([{ id: "new" }]);

		// The stale graph's session_shutdown must not delete the current source.
		first.withdrawSubagentStateSource();
		expect(registry()?.subagents).toBeDefined();
		expect(slot().read().agents).toEqual([{ id: "new" }]);

		// The current owner's withdrawal is honored.
		second.withdrawSubagentStateSource();
		expect(registry()?.subagents).toBeUndefined();
	});
});
