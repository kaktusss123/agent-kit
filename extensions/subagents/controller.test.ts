import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller";
import { formatModelEvent, formatResult, formatStatusList } from "./delivery";
import {
	autoAcceptPrompt,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	settleChild,
} from "./fake-rpc";
import { loadResult, resultsDirFor } from "./result-store";
import type { SubagentModelEvent } from "./types";

function makeRuntime(opts?: { killGraceMs?: number }) {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
	const events: SubagentModelEvent[] = [];
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: opts?.killGraceMs ?? 50,
		startTimeoutMs: 2000,
	});
	runtime.onEvent((ev) => events.push(ev));
	const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	return { harness, runtime, events, tmp, cleanup };
}

async function spawnRunning(
	runtime: LocalSubagentRuntime,
	harness: ReturnType<typeof createFakeSpawnFactory>,
	task = "do things",
): Promise<{ id: string; proc: FakeRpcProcess }> {
	const pendingSpawn = runtime.spawn({ task, label: "lab" });
	// wait for the fake process to exist, then auto-accept
	await new Promise((r) => setTimeout(r, 5));
	const proc = harness.spawned[harness.spawned.length - 1];
	autoAcceptPrompt(proc);
	const snap = await pendingSpawn;
	expect(snap.state).toBe("running");
	return { id: snap.id, proc };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("LocalSubagentRuntime.spawn", () => {
	test("resolves on prompt acceptance and passes a minimal controlled argv", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			await spawnRunning(runtime, harness);
			const proc = harness.spawned[0];
			expect(proc.spec.args).toContain("--mode");
			expect(proc.spec.args).toContain("rpc");
			expect(proc.spec.args).toContain("--no-extensions");
			const bridgeIdx = proc.spec.args.indexOf("-e");
			expect(proc.spec.args[bridgeIdx + 1]).toBe("/fake/bridge.ts");
			const prompt = proc.commands.find((c) => c.type === "prompt");
			expect(prompt).toBeDefined();
			expect(prompt!.message).toBe("do things");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("fails when the child exits before accepting the prompt", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "x" });
			await tick(5);
			harness.spawned[0].close(1, null);
			await expect(pending).rejects.toThrow(/exited before accepting/);
			await tick(5);
			expect(events.some((e) => e.kind === "failed")).toBe(true);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime settle flow", () => {
	test("settled child becomes completed with persisted result", async () => {
		const { harness, runtime, events, tmp, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleChild(proc, "All checks pass, 2 issues found");
			await tick(60);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: "completed", agentId: id });
			expect((events[0] as { summary: string }).summary).toContain("2 issues");

			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("completed");
			expect(snap.sessionFile).toBe("/tmp/fake-session.jsonl");

			const result = await runtime.result(id);
			expect(result).not.toBeNull();
			expect(result!.status).toBe("completed");
			expect(result!.finalText).toBe("All checks pass, 2 issues found");
			expect(result!.tokens).toMatchObject({ total: 15 });

			// persisted in the child cwd results dir
			const persisted = loadResult(id, resultsDirFor(tmp));
			expect(persisted?.finalText).toContain("2 issues");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("unexpected exit while running becomes failed, not stuck running", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.close(null, "SIGKILL"); // crash
			await tick(10);
			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("failed");
			expect(events[0]).toMatchObject({ kind: "failed", agentId: id });
			const result = await runtime.result(id);
			expect(result!.status).toBe("failed");
			expect(result!.failureReason).toContain("unexpectedly");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("error stopReason at settle marks the agent failed", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "provider exploded" },
			});
			settleChild(proc, "partial text");
			await tick(60);
			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("failed");
			expect(events[0]).toMatchObject({ kind: "failed", agentId: id });
			expect((events[0] as { reason: string }).reason).toContain("provider exploded");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime races", () => {
	test("two children settling simultaneously produce both events, none lost", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const p1 = runtime.spawn({ task: "a", label: "a" });
			const p2 = runtime.spawn({ task: "b", label: "b" });
			await tick(5);
			autoAcceptPrompt(harness.spawned[0]);
			autoAcceptPrompt(harness.spawned[1]);
			const [s1, s2] = await Promise.all([p1, p2]);
			// settle both in the same tick
			settleChild(harness.spawned[0], "result-A");
			settleChild(harness.spawned[1], "result-B");
			await tick(80);
			expect(events).toHaveLength(2);
			const ids = new Set(events.map((e) => e.agentId));
			expect(ids).toEqual(new Set([s1.id, s2.id]));
			expect(events.every((e) => e.kind === "completed")).toBe(true);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime wait", () => {
	test("wait consumes the event and suppresses background delivery", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			const pending = runtime.wait(id);
			settleChild(proc, "done via wait");
			const outcome = await pending;
			expect(outcome).toMatchObject({ status: "completed" });
			await tick(30);
			// consumed by the waiter — nothing delivered in the background
			expect(events).toHaveLength(0);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("wait on already-settled agent resolves immediately from its state", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleChild(proc, "already done");
			await tick(60);
			expect(events).toHaveLength(1); // delivered in background
			const outcome = await runtime.wait(id);
			expect(outcome).toMatchObject({ status: "completed" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("wait returns needs_input for an asking child", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			const pending = runtime.wait(id);
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-1",
				method: "input",
				title: "ask_parent",
				placeholder: "Which database?",
			});
			const outcome = await pending;
			expect(outcome).toMatchObject({ status: "needs_input", question: "Which database?" });
			expect(runtime.inspect(id)[0].state).toBe("waiting_input");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime escalation (ask_parent)", () => {
	test("respond delivers extension_ui_response and resumes the child", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-42",
				method: "input",
				title: "ask_parent",
				placeholder: "Pick a color",
			});
			await tick(10);
			expect(runtime.inspect(id)[0].state).toBe("waiting_input");
			expect(events[0]).toMatchObject({ kind: "needs_input", agentId: id });

			await runtime.respond(id, "blue");
			await tick(10);
			const resp = proc.commands.find((c) => c.type === "extension_ui_response");
			expect(resp).toMatchObject({ id: "ui-42", value: "blue" });
			expect(runtime.inspect(id)[0].state).toBe("running");
			expect(runtime.inspect(id)[0].pendingQuestion).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("duplicate ui request while one is pending is dismissed", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "extension_ui_request", id: "ui-1", method: "input", title: "ask_parent", placeholder: "q1",
			});
			await tick(5);
			proc.writeToStdout({
				type: "extension_ui_request", id: "ui-2", method: "input", title: "ask_parent", placeholder: "q2",
			});
			await tick(5);
			const resp = proc.commands.find((c) => c.type === "extension_ui_response");
			expect(resp).toMatchObject({ id: "ui-2", cancelled: true });
			expect(runtime.inspect(id)[0].pendingQuestion).toBe("q1");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("fire-and-forget ui notifications are ignored", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
			proc.writeToStdout({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetLines: ["x"] });
			await tick(10);
			expect(runtime.inspect(id)[0].state).toBe("running");
			expect(events).toHaveLength(0);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime steer / followUp", () => {
	test("steer on a running child sends RPC steer", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			await runtime.steer(id, "change direction");
			const cmd = proc.commands.find((c) => c.type === "steer");
			expect(cmd).toMatchObject({ message: "change direction" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("steer on an idle completed child is rejected", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleChild(proc, "done");
			await tick(60);
			await expect(runtime.steer(id, "x")).rejects.toThrow(/not running/);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up on a running child queues via RPC follow_up", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			await runtime.followUp(id, "then do this");
			const cmd = proc.commands.find((c) => c.type === "follow_up");
			expect(cmd).toMatchObject({ message: "then do this" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up on an idle completed child is translated into a prompt and re-runs", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleChild(proc, "first run done");
			await tick(60);
			await runtime.followUp(id, "now continue");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.id !== "spawn-prompt");
			expect(cmd).toMatchObject({ message: "now continue" });
			expect(runtime.inspect(id)[0].state).toBe("running");

			// second settle emits completed again
			settleChild(proc, "second run done");
			await tick(80);
			const completions = events.filter((e) => e.kind === "completed");
			expect(completions).toHaveLength(2);
			const result = await runtime.result(id);
			expect(result!.finalText).toBe("second run done");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up while waiting for input is rejected", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "extension_ui_request", id: "ui-1", method: "input", title: "ask_parent", placeholder: "q",
			});
			await expect(runtime.followUp(id, "x")).rejects.toThrow(/waiting for input/);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime cancel", () => {
	test("cancel aborts, SIGTERMs, and marks cancelled; waiters see it", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			const pending = runtime.wait(id);
			await runtime.cancel(id);
			const outcome = await pending;
			expect(outcome.status).toBe("cancelled");
			expect(proc.signalsReceived).toContain("SIGTERM");
			expect(proc.commands.some((c) => c.type === "abort")).toBe(true);
			expect(runtime.inspect(id)[0].state).toBe("cancelled");
			const result = await runtime.result(id);
			expect(result!.status).toBe("cancelled");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("cancel escalates to SIGKILL when SIGTERM is ignored", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.ignoreSigterm = true;
			await runtime.cancel(id);
			expect(proc.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
			expect(runtime.inspect(id)[0].state).toBe("cancelled");
			expect(runtime.inspect(id)[0].signal).toBe("SIGKILL");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("cancel of an already-dead agent is a no-op that still settles state", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.close(null, "SIGKILL"); // crash first
			await tick(10);
			expect(events[0].kind).toBe("failed");
			await runtime.cancel(id); // must not throw nor re-emit
			expect(events.filter((e) => e.kind === "cancelled")).toHaveLength(0);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("LocalSubagentRuntime shutdown", () => {
	test("kills all live children", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			await spawnRunning(runtime, harness, "a");
			await spawnRunning(runtime, harness, "b");
			await runtime.shutdown();
			expect(harness.spawned.every((p) => p.closed)).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("delivery formatting", () => {
	test("model events are compact and reference lazy result access", () => {
		const text = formatModelEvent({
			kind: "completed",
			agentId: "sa-1-abcd",
			label: "reviewer",
			summary: "Found 2 correctness issues",
		});
		expect(text).toContain("[subagent completed]");
		expect(text).toContain("sa-1-abcd");
		expect(text).toContain("op=result");
		expect(text).not.toContain("transcript");

		const ni = formatModelEvent({
			kind: "needs_input", agentId: "sa-2", label: "w", question: "Use which port?",
		});
		expect(ni).toContain("needs input");
		expect(ni).toContain("op=respond");
	});

	test("result formatting never includes more than the result itself", () => {
		const text = formatResult({
			id: "sa-1",
			label: "reviewer",
			task: "review code",
			cwd: "/tmp",
			status: "completed",
			finalText: "issues: 2",
			summary: "issues: 2",
			startedAt: 1,
			endedAt: 2,
		});
		expect(text).toContain("issues: 2");
		expect(text).toContain("completed");
	});

	test("status list orders active states first", () => {
		const lines = formatStatusList([
			{
				id: "done", label: "d", state: "completed", task: "t", cwd: "/x",
				alive: false, startedAt: 1, lastActivityAt: 2, elapsedMs: 5,
			},
			{
				id: "run", label: "r", state: "running", task: "t", cwd: "/x",
				alive: true, startedAt: 1, lastActivityAt: 2, elapsedMs: 5,
			},
		]);
		const first = lines.split("\n")[0];
		expect(first).toContain("run");
	});
});
