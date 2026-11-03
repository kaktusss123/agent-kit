/**
 * Contract test: the two Core sources are discovered through ONE registered
 * symbol, are independent, and the two module copies agree on the registry
 * identity. This is the cross-loader property expressed without a jiti graph:
 * the task-workspace copy and the subagents copy are separate module
 * instances (same as Pi's per-entry loader graphs), so agreement can only come
 * from the registered symbol and the documented versions.
 */
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const subagentsPath = path.join(repoRoot, "extensions/subagents/read-only-state.ts");
const taskPath = path.join(repoRoot, "extensions/task-workspace/read-only-state.ts");
const KEY = Symbol.for("agentkit.read-only-state.v1");

const subagents = await import(subagentsPath);
const task = await import(taskPath);

afterAll(() => {
	delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("read-only state contract: shared registry identity", () => {
	test("both copies resolve the same registered symbol name and schema version", () => {
		expect(subagents).not.toBe(task);
		expect(Symbol.keyFor(subagents.READ_ONLY_STATE_KEY)).toBe("agentkit.read-only-state.v1");
		expect(subagents.READ_ONLY_STATE_KEY).toBe(task.READ_ONLY_STATE_KEY);
		expect(subagents.READ_ONLY_STATE_KEY).toBe(KEY);
		expect(subagents.READ_ONLY_STATE_SCHEMA_VERSION).toBe(1);
		expect(task.READ_ONLY_STATE_SCHEMA_VERSION).toBe(subagents.READ_ONLY_STATE_SCHEMA_VERSION);
		expect(subagents.SUBAGENTS_SOURCE_VERSION).toBe(1);
		expect(task.TASK_WORKSPACE_SOURCE_VERSION).toBe(1);
	});

	test("one registry object carries both slots, and each source is withdrawn independently", async () => {
		delete (globalThis as Record<symbol, unknown>)[KEY];
		task.publishTaskWorkspaceStateSource({ taskRoot: "/tmp/read-only-state-contract" });
		subagents.publishSubagentStateSource(() => [{ id: "a", label: "a", state: "running", alive: true }]);

		const registry = (globalThis as Record<symbol, unknown>)[KEY] as {
			schemaVersion: number;
			subagents?: { version: number; read: () => { status: string; agents: { id: string }[] } };
			taskWorkspace?: { version: number };
		};
		expect(registry.schemaVersion).toBe(1);
		expect(registry.subagents?.version).toBe(1);
		expect(registry.taskWorkspace?.version).toBe(1);
		expect(registry.subagents?.read().agents.map((a) => a.id)).toEqual(["a"]);

		// Withdrawing one source leaves the other, and its own availability, intact.
		subagents.withdrawSubagentStateSource();
		expect(registry.subagents).toBeUndefined();
		expect(registry.taskWorkspace?.version).toBe(1);
		const taskRead = await registry.taskWorkspace!.read!();
		expect((taskRead as { status: string }).status).toBe("unavailable");

		task.withdrawTaskWorkspaceStateSource();
		expect(registry.taskWorkspace).toBeUndefined();
	});
});
