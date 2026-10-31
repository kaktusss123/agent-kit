/**
 * Unit tests for the RepoOwner primitive patches:
 * - per-spawn additionalExtensions profile + readiness handshake
 * - internal retire() (terminal termination preserving the record)
 * - workspace event routing (event ownership) + runtime wait() lock
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller.ts";
import {
	autoAcceptPrompt,
	confirmReadiness,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	type FakeHarness,
	settleRun,
	startRun,
} from "./fake-rpc.ts";
import { parseReadinessPayload } from "./readiness.ts";
import { validateEnvelope, validateEnvelopeRecord } from "./envelope.ts";
import type { SubagentModelEvent } from "./types.ts";

function makeRuntime(extra?: { readinessTimeoutMs?: number }) {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-profile-test-"));
	const events: SubagentModelEvent[] = [];
	const workspaceEvents: SubagentModelEvent[] = [];
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		webSearchPath: "/fake/web-search.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
		readinessTimeoutMs: extra?.readinessTimeoutMs ?? 300,
	});
	runtime.onEvent((ev) => events.push(ev));
	runtime.onWorkspaceEvent((ev) => workspaceEvents.push(ev));
	const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	return { harness, runtime, events, workspaceEvents, tmp, cleanup };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function spawnProfiled(
	runtime: LocalSubagentRuntime,
	harness: FakeHarness,
	opts: { task?: string; entries?: Record<string, string[]> } = {},
): Promise<{ pending: Promise<unknown>; proc: FakeRpcProcess }> {
	const pending = runtime.spawn({
		task: opts.task ?? "the actual task",
		label: "owner-x",
		additionalExtensions: ["/ext/task-workspace/index.ts", "/ext/subagents/reporting-bridge.ts"],
		readinessEntries: opts.entries ?? {
			"task-workspace": ["task_status", "ensure_task_repo"],
			"workspace-reporting": ["report_result"],
		},
		eventRoute: "workspace",
	});
	await tick(5);
	const proc = harness.spawned[harness.spawned.length - 1];
	return { pending, proc };
}

describe("per-spawn additionalExtensions", () => {
	test("profiled child argv carries repeated -e entries and keeps the base bridge", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		const previousRequestFd = process.env.AGENTKIT_INSPECT_REQUEST_FD;
		const previousResponseFd = process.env.AGENTKIT_INSPECT_RESPONSE_FD;
		process.env.AGENTKIT_INSPECT_REQUEST_FD = "41";
		process.env.AGENTKIT_INSPECT_RESPONSE_FD = "42";
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			const args = proc.spec.args;
			const exts = args.map((a, i) => (a === "-e" ? args[i + 1] : null)).filter(Boolean);
			expect(exts).toEqual(["/fake/bridge.ts", "/fake/web-search.ts", "/ext/task-workspace/index.ts", "/ext/subagents/reporting-bridge.ts"]);
			expect(args).toContain("--no-extensions");
			expect(args[args.indexOf("--name") + 1]).toBe("subagent:owner-x");
			// No readiness data travels to the child: the contract stays
			// main-side, the probe only reports the observed tool set.
			expect(proc.spec.env?.PI_SUBAGENT_READINESS_CONTRACT).toBeUndefined();
			expect(proc.spec.env?.AGENTKIT_INSPECT_REQUEST_FD).toBeUndefined();
			expect(proc.spec.env?.AGENTKIT_INSPECT_RESPONSE_FD).toBeUndefined();
			await runtime.shutdown();
			await pending.catch(() => {});
			void autoAcceptPrompt;
		} finally {
			if (previousRequestFd === undefined) delete process.env.AGENTKIT_INSPECT_REQUEST_FD;
			else process.env.AGENTKIT_INSPECT_REQUEST_FD = previousRequestFd;
			if (previousResponseFd === undefined) delete process.env.AGENTKIT_INSPECT_RESPONSE_FD;
			else process.env.AGENTKIT_INSPECT_RESPONSE_FD = previousResponseFd;
			cleanup();
		}
	});

	test("generic children have byte-identical argv (no extra -e, no readiness env)", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		const previousRequestFd = process.env.AGENTKIT_INSPECT_REQUEST_FD;
		const previousResponseFd = process.env.AGENTKIT_INSPECT_RESPONSE_FD;
		process.env.AGENTKIT_INSPECT_REQUEST_FD = "41";
		process.env.AGENTKIT_INSPECT_RESPONSE_FD = "42";
		try {
			const pending = runtime.spawn({ task: "t", label: "g" });
			await tick(5);
			const proc = harness.spawned[0];
			const exts = proc.spec.args.map((a, i) => (a === "-e" ? proc.spec.args[i + 1] : null)).filter(Boolean);
			// The base profile (bridge + web_search) is the whole generic child.
			expect(exts).toEqual(["/fake/bridge.ts", "/fake/web-search.ts"]);
			// The inherited inspection channel is private to the parent in both
			// generic and workspace spawn paths.
			expect(proc.spec.env?.AGENTKIT_INSPECT_REQUEST_FD).toBeUndefined();
			expect(proc.spec.env?.AGENTKIT_INSPECT_RESPONSE_FD).toBeUndefined();
			await runtime.shutdown();
			await pending.catch(() => {});
		} finally {
			if (previousRequestFd === undefined) delete process.env.AGENTKIT_INSPECT_REQUEST_FD;
			else process.env.AGENTKIT_INSPECT_REQUEST_FD = previousRequestFd;
			if (previousResponseFd === undefined) delete process.env.AGENTKIT_INSPECT_RESPONSE_FD;
			else process.env.AGENTKIT_INSPECT_RESPONSE_FD = previousResponseFd;
			cleanup();
		}
	});
});

describe("readiness handshake", () => {
	test("withholds the task prompt until the tool-set report covers every entry, then dispatches", async () => {
		const { runtime, harness, cleanup } = makeRuntime();
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			await tick(20);
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
			// A report missing a required tool cannot satisfy the contract:
			// reporting_result is still missing, so the spawn fails closed.
			confirmReadiness(proc, { tools: ["task_status", "ensure_task_repo"] });
			await expect(pending).rejects.toThrow(/readiness handshake failed/);
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("a complete tool-set report dispatches the task prompt", async () => {
		const { runtime, harness, cleanup } = makeRuntime();
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			await tick(20);
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
			confirmReadiness(proc, { tools: ["task_status", "ensure_task_repo", "report_result"] });
			autoAcceptPrompt(proc);
			await pending;
			const prompt = proc.commands.find((c) => c.type === "prompt" && c.id === "spawn-prompt");
			expect(prompt).toBeDefined();
			expect(prompt!.message).toBe("the actual task");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("ignores foreign notifies (wrong protocol marker)", async () => {
		const { runtime, harness, cleanup } = makeRuntime();
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			await tick(20);
			confirmReadiness(proc, { tools: ["anything"], protocol: "some-other-protocol" });
			await tick(20);
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
			confirmReadiness(proc, { tools: ["task_status", "ensure_task_repo", "report_result"] });
			autoAcceptPrompt(proc);
			await pending;
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("missing required tools fail the spawn, kill the child, task never sent", async () => {
		const { runtime, harness, cleanup } = makeRuntime();
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			confirmReadiness(proc, { tools: ["task_status"] }); // ensure_task_repo and report_result missing
			await expect(pending).rejects.toThrow(/missing required tools: ensure_task_repo/);
			expect(proc.signalsReceived).toContain("SIGKILL");
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("no readiness report times out: child killed, task never sent", async () => {
		const { runtime, harness, cleanup } = makeRuntime({ readinessTimeoutMs: 60 });
		try {
			const { pending, proc } = await spawnProfiled(runtime, harness);
			await expect(pending).rejects.toThrow(/readiness handshake did not complete in time/);
			expect(proc.signalsReceived).toContain("SIGKILL");
			expect(proc.commands.find((c) => c.type === "prompt")).toBeUndefined();
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

test("readiness payload parsing rejects malformed or foreign notifies", () => {
	expect(parseReadinessPayload(undefined)).toBeUndefined();
	expect(parseReadinessPayload("not json")).toBeUndefined();
	expect(parseReadinessPayload(JSON.stringify({ protocol: "pi-subagents-readiness" }))).toBeUndefined();
	expect(parseReadinessPayload(JSON.stringify({ protocol: "other", tools: [] }))).toBeUndefined();
	const good = parseReadinessPayload(JSON.stringify({ protocol: "pi-subagents-readiness", tools: ["t"] }));
	expect(good).toMatchObject({ protocol: "pi-subagents-readiness", tools: ["t"] });
});
});

describe("retire() — terminal termination preserving the record", () => {
	test("retire kills the settled child but keeps completed state, result and emits no cancelled event", async () => {
		const { harness, runtime, events, tmp, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "t", label: "lab" });
			await tick(5);
			const proc = harness.spawned[0];
			autoAcceptPrompt(proc);
			const snap = await pending;
			settleRun(proc, "work finished");
			await tick(60);
			expect(events.some((e) => e.kind === "completed")).toBe(true);

			await runtime.retire(snap.id);
			await tick(20);
			expect(proc.closed).toBe(true);

			const after = runtime.inspect(snap.id)[0];
			expect(after.state).toBe("completed"); // never cancelled
			expect(after.alive).toBe(false);
			const result = await runtime.result(snap.id);
			expect(result?.status).toBe("completed");
			expect(result?.finalText).toBe("work finished");
			expect(events.some((e) => e.kind === "cancelled")).toBe(false);
			void tmp;
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("retire of an already-exited agent is a no-op that keeps the record", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "t", label: "lab" });
			await tick(5);
			const proc = harness.spawned[0];
			autoAcceptPrompt(proc);
			const snap = await pending;
			settleRun(proc, "finished cleanly");
			await tick(60);
			proc.close(0, null); // self-exit after settling: state stays completed
			await tick(10);
			await runtime.retire(snap.id); // must not throw
			expect(runtime.inspect(snap.id)[0].state).toBe("completed");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("input_resolved routing (F3)", () => {
	test("respond emits input_resolved to the workspace layer; a second ask emits a fresh needs_input", async () => {
		const { harness, runtime, events, workspaceEvents, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "t", label: "owner-i", eventRoute: "workspace" });
			await tick(5);
			const proc = harness.spawned[0];
			autoAcceptPrompt(proc);
			const snap = await pending;

			// first question: needs_input routed to the workspace layer only
			proc.writeToStdout({ type: "extension_ui_request", id: "ui-1", method: "input", title: "ask", placeholder: JSON.stringify({ questions: [{ id: "q1", question: "q one", options: [{ label: "a" }] }] }) });
			await tick(20);
			expect(workspaceEvents.some((e) => e.kind === "needs_input" && (e as any).question === "q1: q one (a)")).toBe(true);

			// Main responds: input_resolved clears the pending question
			await runtime.respond(snap.id, "a1");
			await tick(20);
			expect(workspaceEvents.some((e) => e.kind === "input_resolved")).toBe(true);
			expect(runtime.inspect(snap.id)[0]!.pendingQuestion).toBeUndefined();

			// second question: a fresh needs_input (no dedup, no swallow)
			proc.writeToStdout({ type: "extension_ui_request", id: "ui-2", method: "input", title: "ask", placeholder: JSON.stringify({ questions: [{ id: "q2", question: "q two", options: [{ label: "b" }] }] }) });
			await tick(20);
			expect(workspaceEvents.some((e) => e.kind === "needs_input" && (e as any).question === "q2: q two (b)")).toBe(true);

			// child-side dialog timeout resolves the question: input_resolved again
			proc.writeToStdout({ type: "tool_execution_end", toolName: "ask", toolCallId: "tc-2" });
			await tick(20);
			const resolved = workspaceEvents.filter((e) => e.kind === "input_resolved");
			expect(resolved.length).toBe(2);
			expect(runtime.inspect(snap.id)[0]!.state).toBe("running");
			expect(events).toHaveLength(0); // generic policy still sees nothing
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("workspace event routing", () => {
	test("lifecycle events of workspace children reach the workspace layer only; wait() is locked", async () => {
		const { harness, runtime, events, workspaceEvents, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({
				task: "t",
				label: "owner-w",
				additionalExtensions: ["/ext/a.ts"],
				readinessEntries: { e: ["t"] },
				eventRoute: "workspace",
			});
			await tick(5);
			const proc = harness.spawned[0];
			confirmReadiness(proc, { tools: ["t"] });
			autoAcceptPrompt(proc);
			const snap = await pending;
			expect(runtime.isWorkspaceRouted(snap.id)).toBe(true);

			settleRun(proc, "owner work done");
			await tick(60);
			expect(workspaceEvents).toHaveLength(1);
			expect(workspaceEvents[0]).toMatchObject({ kind: "completed", agentId: snap.id });
			expect(events).toHaveLength(0); // generic policy never sees it

			await expect(runtime.wait(snap.id)).rejects.toThrow(/workspace-owned/);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("needs_input of a workspace child routes to the workspace layer only", async () => {
		const { harness, runtime, events, workspaceEvents, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({
				task: "t",
				label: "owner-w",
				eventRoute: "workspace",
			});
			await tick(5);
			const proc = harness.spawned[0];
			autoAcceptPrompt(proc);
			const snap = await pending;
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-1",
				method: "input",
				title: "ask",
				placeholder: JSON.stringify({ questions: [{ id: "base", question: "Which base ref?", options: [{ label: "main" }] }] }),
			});
			await tick(20);
			expect(workspaceEvents).toHaveLength(1);
			expect(workspaceEvents[0]).toMatchObject({ kind: "needs_input", question: "base: Which base ref? (main)" });
			expect(events).toHaveLength(0);
			expect(runtime.inspect(snap.id)[0].state).toBe("waiting_input");
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("generic children keep the default routing (regression guard)", async () => {
		const { harness, runtime, events, workspaceEvents, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "t", label: "g" });
			await tick(5);
			const proc = harness.spawned[0];
			autoAcceptPrompt(proc);
			const snap = await pending;
			expect(runtime.isWorkspaceRouted(snap.id)).toBe(false);
			settleRun(proc, "done");
			await tick(60);
			expect(events).toHaveLength(1);
			expect(workspaceEvents).toHaveLength(0);
			startRun(proc); // no-op; keeps import used
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

describe("envelope validation", () => {
	const validEnvelope = {
		status: "done",
		summary: "s",
		changed_scope: ["a.md"],
		verification: [{ check: "bun test", result: "pass" }],
		gaps: [],
	};

	test("accepts a valid envelope and record", () => {
		expect(validateEnvelope(validEnvelope)).toMatchObject({ status: "done" });
		const record = {
			agentId: "sa-1-x",
			generation: 1,
			stale: false,
			reportedAt: 123,
			envelope: validEnvelope,
		};
		expect(validateEnvelopeRecord(record)?.envelope.summary).toBe("s");
	});

	test("rejects unknown keys, bad statuses, broken verification entries", () => {
		expect(validateEnvelope({ ...validEnvelope, extra: 1 })).toBeUndefined();
		expect(validateEnvelope({ ...validEnvelope, status: "victory" })).toBeUndefined();
		expect(
			validateEnvelope({ ...validEnvelope, verification: [{ check: "x", result: "maybe" }] }),
		).toBeUndefined();
		expect(
			validateEnvelope({ ...validEnvelope, verification: [{ check: "x", result: "pass", who: "me" }] }),
		).toBeUndefined();
		expect(validateEnvelopeRecord({ ...{ agentId: "a", generation: 1, stale: false, reportedAt: 1 } })).toBeUndefined();
	});
});
