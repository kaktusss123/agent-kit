/**
 * Tests for LiveSubagentRuntime.pushProxyPreference — the live-child proxy
 * propagation over the existing RPC prompt path.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller.ts";
import { autoAcceptPrompt, createFakeSpawnFactory, type FakeRpcProcess } from "./fake-rpc.ts";
import type { SubagentModelEvent } from "./types.ts";

function makeRuntime(opts?: { dispatchTimeoutMs?: number }) {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-push-test-"));
	const events: SubagentModelEvent[] = [];
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: opts?.dispatchTimeoutMs ?? 2000,
	});
	runtime.onEvent((ev) => events.push(ev));
	const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	return { harness, runtime, events, tmp, cleanup };
}

async function spawnRunning(
	runtime: LocalSubagentRuntime,
	harness: ReturnType<typeof createFakeSpawnFactory>,
): Promise<{ id: string; proc: FakeRpcProcess }> {
	const pendingSpawn = runtime.spawn({ task: "do things", label: "lab" });
	await new Promise((r) => setTimeout(r, 5));
	const proc = harness.spawned[harness.spawned.length - 1];
	autoAcceptPrompt(proc);
	const snap = await pendingSpawn;
	expect(snap.state).toBe("running");
	return { id: snap.id, proc };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("pushProxyPreference", () => {
	test("sends /proxy on as an RPC prompt and counts the ack", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { proc } = await spawnRunning(runtime, harness);
			const pending = runtime.pushProxyPreference(true);
			await tick(10);
			const push = proc.commands.find((c) => c.type === "prompt" && c.message === "/proxy on");
			expect(push).toBeDefined();
			proc.writeToStdout({ id: push!.id, type: "response", command: "prompt", success: true });
			await expect(pending).resolves.toEqual({ acked: 1, total: 1 });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("sends /proxy off symmetrically", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { proc } = await spawnRunning(runtime, harness);
			const pending = runtime.pushProxyPreference(false);
			await tick(10);
			const push = proc.commands.find((c) => c.type === "prompt" && c.message === "/proxy off");
			expect(push).toBeDefined();
			proc.writeToStdout({ id: push!.id, type: "response", command: "prompt", success: true });
			await expect(pending).resolves.toEqual({ acked: 1, total: 1 });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("a child that never acks counts as unacked, no retry queue", async () => {
		const { harness, runtime, cleanup } = makeRuntime({ dispatchTimeoutMs: 80 });
		try {
			await spawnRunning(runtime, harness);
			const result = await runtime.pushProxyPreference(true);
			expect(result).toEqual({ acked: 0, total: 1 });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("an exited child is skipped entirely", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { proc } = await spawnRunning(runtime, harness);
			proc.close(0, null);
			await tick(10);
			const result = await runtime.pushProxyPreference(true);
			expect(result).toEqual({ acked: 0, total: 0 });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("several live children all receive the same preference", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const a = await spawnRunning(runtime, harness);
			const b = await spawnRunning(runtime, harness);
			// pushProxyPreference iterates sequentially: ack child a, then b.
			const pending = runtime.pushProxyPreference(true);
			await tick(10);
			const pushA = a.proc.commands.find((c) => c.type === "prompt" && c.message === "/proxy on");
			expect(pushA).toBeDefined();
			a.proc.writeToStdout({ id: pushA!.id, type: "response", command: "prompt", success: true });
			await tick(10);
			const pushB = b.proc.commands.find((c) => c.type === "prompt" && c.message === "/proxy on");
			expect(pushB).toBeDefined();
			b.proc.writeToStdout({ id: pushB!.id, type: "response", command: "prompt", success: true });
			await expect(pending).resolves.toEqual({ acked: 2, total: 2 });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});
