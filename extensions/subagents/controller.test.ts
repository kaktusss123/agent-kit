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
	settleRun,
	startRun,
} from "./fake-rpc";
import { loadResult } from "./result-store";
import type { SubagentModelEvent } from "./types";

function makeRuntime(opts?: { killGraceMs?: number; dispatchTimeoutMs?: number }) {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
	const events: SubagentModelEvent[] = [];
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: opts?.killGraceMs ?? 50,
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
			settleRun(proc, "All checks pass, 2 issues found");
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
			const persisted = loadResult(id, tmp);
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
			settleRun(proc, "partial text");
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
			settleRun(harness.spawned[0], "result-A");
			settleRun(harness.spawned[1], "result-B");
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
			settleRun(proc, "done via wait");
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
			settleRun(proc, "already done");
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
	test("steer on a running child sends prompt with steering behavior", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			await runtime.steer(id, "change direction");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "steer");
			expect(cmd).toMatchObject({ message: "change direction" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("steer on an idle completed child delegates to pi (prompt + steer)", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "done");
			await tick(60);
			// No controller-side guess: pi decides queue vs fresh run.
			await runtime.steer(id, "wake up with this");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "steer");
			expect(cmd).toMatchObject({ message: "wake up with this" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up on a running child sends prompt with followUp behavior", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			await runtime.followUp(id, "then do this");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(cmd).toMatchObject({ message: "then do this" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up on an idle completed child re-runs via pi's followUp queue", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "first run done");
			await tick(60);
			await runtime.followUp(id, "now continue");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(cmd).toMatchObject({ message: "now continue" });

			// pi starts the queued follow-up as a new run (agent_start), then settles
			startRun(proc);
			settleRun(proc, "second run done");
			await tick(80);
			expect(runtime.inspect(id)[0].state).toBe("completed");
			const completions = events.filter((e) => e.kind === "completed");
			expect(completions).toHaveLength(2);
			const result = await runtime.result(id);
			expect(result!.finalText).toBe("second run done");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("follow_up while waiting for input is accepted and queued by pi", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "extension_ui_request", id: "ui-1", method: "input", title: "ask_parent", placeholder: "q",
			});
			await tick(5);
			await runtime.followUp(id, "x");
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(cmd).toMatchObject({ message: "x" });
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


describe("regressions: wait must not swallow later completion", () => {
	test("F1: timeout does not consume the completion that arrives later", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			const outcome = await runtime.wait(id, { timeoutMs: 40 });
			expect(outcome.status).toBe("timeout");

			// child completes after the wait gave up
			settleRun(proc, "late completion");
			await tick(60);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: "completed", agentId: id });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("F1: abort of the wait does not consume the completion either", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			const controller = new AbortController();
			const pending = runtime.wait(id, { signal: controller.signal });
			controller.abort();
			const outcome = await pending;
			expect(outcome.status).toBe("timeout");

			settleRun(proc, "late completion after abort");
			await tick(60);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: "completed" });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("regressions: transient provider errors", () => {
	test("F2: error followed by successful retry settles completed, not failed", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			// attempt 1 fails
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "503 overloaded" },
			});
			// pi retries: new low-level run, retry reported, then success
			proc.writeToStdout({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
			proc.writeToStdout({ type: "auto_retry_end", success: true, attempt: 2 });
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", errorMessage: undefined },
			});
			settleRun(proc, "recovered answer");
			await tick(80);

			expect(runtime.inspect(id)[0].state).toBe("completed");
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: "completed" });
			const result = await runtime.result(id);
			expect(result!.status).toBe("completed");
			expect(result!.failureReason).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("F2: retry that never succeeds still fails the run", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "503 overloaded" },
			});
			proc.writeToStdout({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded: exhausted" });
			settleRun(proc, "");
			await tick(80);

			expect(runtime.inspect(id)[0].state).toBe("failed");
			expect(events[0]).toMatchObject({ kind: "failed", agentId: id });
			expect((events[0] as { reason: string }).reason).toContain("exhausted");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("regressions: per-run state resets", () => {
	test("F4: crash of run #2 after a completed run #1 becomes failed, not stuck running", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "run one done");
			await tick(60);
			expect(runtime.inspect(id)[0].state).toBe("completed");

			// run #2 opens (agent_start arrives) and the process is SIGKILLed before settling
			await runtime.followUp(id, "run two");
			proc.writeToStdout({ type: "agent_start" });
			proc.close(null, "SIGKILL");
			await tick(20);

			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("failed");
			expect(snap.alive).toBe(false);
			const last = events[events.length - 1];
			expect(last).toMatchObject({ kind: "failed", agentId: id });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("F4: a failed run does not poison a successful rerun", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "boom attempt 1" },
			});
			settleRun(proc, "");
			await tick(60);
			expect(runtime.inspect(id)[0].state).toBe("failed");

			await runtime.followUp(id, "try again");
			startRun(proc); // pi opens run #2; agent_start resets run-local state
			settleRun(proc, "recovered on run two");
			await tick(80);

			expect(runtime.inspect(id)[0].state).toBe("completed");
			const completions = events.filter((e) => e.kind === "completed");
			expect(completions).toHaveLength(1);
			const result = await runtime.result(id);
			expect(result!.status).toBe("completed");
			expect(result!.failureReason).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("regressions: ask_parent dialog lifetime sync", () => {
	test("F5: ask_parent tool end clears the pending question even without a response", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "extension_ui_request", id: "ui-9", method: "input", title: "ask_parent", placeholder: "pick one",
			});
			await tick(5);
			expect(runtime.inspect(id)[0].state).toBe("waiting_input");

			// child-side timeout: pi resolves the dialog locally and the tool
			// call ends WITHOUT any extension_ui_response
			proc.writeToStdout({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "ask_parent",
				result: { content: [{ type: "text", text: "(no answer)" }] },
				isError: false,
			});
			await tick(5);

			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("running");
			expect(snap.pendingQuestion).toBeUndefined();
			await expect(runtime.respond(id, "late answer")).rejects.toThrow(/no pending question/);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("regressions: kill-all must not latch the runtime", () => {
	test("F7: cancelAll keeps the runtime usable for new spawns", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { proc } = await spawnRunning(runtime, harness, "first");
			await runtime.cancelAll();
			expect(proc.closed).toBe(true);

			// a new spawn must work after kill-all
			const next = await spawnRunning(runtime, harness, "second");
			expect(next.proc.closed).toBe(false);
			expect(runtime.inspect(next.id)[0].state).toBe("running");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});


describe("regressions: stale terminal result vs pending dispatch", () => {
	test("F9: follow_up over completed hides the old result until the new run starts", async () => {
		const { harness, runtime, events, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "A");
			await tick(60);
			expect(runtime.inspect(id)[0].state).toBe("completed");

			await runtime.followUp(id, "do B");

			// no agent_start yet: the old completion must not leak through
			const early = await runtime.wait(id, { timeoutMs: 40 });
			expect(early.status).toBe("timeout");
			expect(await runtime.result(id)).toBeNull();

			// the new run actually starts and settles
			startRun(proc);
			settleRun(proc, "B");
			const outcome = await runtime.wait(id, { timeoutMs: 5000 });
			expect(outcome).toMatchObject({ status: "completed" });
			expect((outcome as { summary: string }).summary).toBe("B");
			const result = await runtime.result(id);
			expect(result!.finalText).toBe("B");

			// exactly one background completion exists — run #1's "A"; "B" was
			// consumed by the wait() above, not duplicated
			const completions = events.filter((e) => e.kind === "completed");
			expect(completions).toHaveLength(1);
			expect((completions[0] as { summary: string }).summary).toBe("A");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("F9: a rejected preflight clears the stale mark and surfaces the error", async () => {
		const { harness, runtime, cleanup } = makeRuntime({ dispatchTimeoutMs: 500 });
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "A");
			await tick(60);

			// make pi reject the dispatch
			proc.autoRespondPrompts = false;
			const pending = runtime.followUp(id, "do B");
			await tick(20);
			const cmd = proc.commands.find((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			proc.writeToStdout({
				id: cmd!.id, type: "response", command: "prompt", success: false, error: "no model",
			});
			await expect(pending).rejects.toThrow(/pi rejected the followUp/);

			// the previous terminal result is visible again
			expect(runtime.inspect(id)[0].state).toBe("completed");
			const result = await runtime.result(id);
			expect(result!.finalText).toBe("A");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("F9: an unacknowledged dispatch times out without corrupting state", async () => {
		const { harness, runtime, cleanup } = makeRuntime({ dispatchTimeoutMs: 80 });
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			settleRun(proc, "A");
			await tick(60);

			proc.autoRespondPrompts = false;
			await expect(runtime.followUp(id, "do B")).rejects.toThrow(/did not acknowledge/);

			expect(runtime.inspect(id)[0].state).toBe("completed");
			expect((await runtime.result(id))!.finalText).toBe("A");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("regressions: error separation", () => {
	test("F11: a provider failure of run #1 does not linger as process error after run #2", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const { id, proc } = await spawnRunning(runtime, harness);
			proc.writeToStdout({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "boom attempt 1" },
			});
			settleRun(proc, "");
			await tick(60);
			expect(runtime.inspect(id)[0].lastError).toBe("boom attempt 1");

			await runtime.followUp(id, "try again");
			startRun(proc);
			settleRun(proc, "recovered");
			await tick(80);

			const snap = runtime.inspect(id)[0];
			expect(snap.state).toBe("completed");
			expect(snap.lastError).toBeUndefined();
			const result = await runtime.result(id);
			expect(result!.failureReason).toBeUndefined();
		} finally {
			await runtime.shutdown();
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
