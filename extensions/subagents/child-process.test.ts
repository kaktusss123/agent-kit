/**
 * ChildAgentProcess unit tests: one child pi process driven directly, with no
 * collection around it. These pin the invariants the runtime relies on —
 * fail-closed readiness, a single dispatch, single settlement, cancellation
 * that never re-dispatches, and independent per-child state.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import {
	ChildAgentProcess,
	type ChildAgentHost,
	type ChildAgentSpec,
	type ChildMarkerFacts,
	type ChildResultFacts,
	type ChildTimeouts,
} from "./child-process.ts";
import {
	autoAcceptPrompt,
	confirmReadiness,
	createFakeSpawnFactory,
	settleRun,
	type FakeHarness,
} from "./fake-rpc.ts";
import type { SubagentModelEvent } from "./types.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const BASE_TIMEOUTS: ChildTimeouts = {
	startMs: 2000,
	dispatchMs: 2000,
	readinessMs: 300,
	killGraceMs: 50,
};

function makeChild(opts?: {
	readinessEntries?: Record<string, string[]>;
	timeouts?: Partial<ChildTimeouts>;
	idleExitMs?: number;
}): {
	child: ChildAgentProcess;
	harness: FakeHarness;
	events: SubagentModelEvent[];
	results: ChildResultFacts[];
	markers: ChildMarkerFacts[];
	costs: Array<{ agentId: string; cost: number }>;
	changes: () => number;
} {
	const harness = createFakeSpawnFactory();
	const events: SubagentModelEvent[] = [];
	const results: ChildResultFacts[] = [];
	const markers: ChildMarkerFacts[] = [];
	const costs: Array<{ agentId: string; cost: number }> = [];
	let changes = 0;
	const host: ChildAgentHost = {
		emit: (ev) => events.push(ev),
		changed: () => {
			changes++;
		},
		persistResult: (facts) => results.push(facts),
		persistMarker: (facts) => markers.push(facts),
		costReported: (agentId, cost) => costs.push({ agentId, cost }),
	};
	const spec: ChildAgentSpec = {
		id: `child-${Math.random().toString(36).slice(2, 8)}`,
		label: "kid",
		task: "the task",
		initialPrompt: "the task",
		cwd: "/tmp",
		command: "node",
		args: [],
		env: {},
		spawnFn: harness.spawnFn,
		idleExitMs: opts?.idleExitMs ?? 0,
		...(opts?.readinessEntries ? { readinessEntries: opts.readinessEntries } : {}),
	};
	const child = new ChildAgentProcess(
		spec,
		{ ...BASE_TIMEOUTS, ...opts?.timeouts },
		host,
	);
	return { child, harness, events, results, markers, costs, changes: () => changes };
}

const prompts = (harness: FakeHarness) =>
	harness.spawned[0].commands.filter((c) => c.type === "prompt");

describe("ChildAgentProcess start", () => {
	test("dispatches immediately without a readiness contract and resolves on acceptance", async () => {
		const { child, harness } = makeChild();
		const pending = child.start();
		await tick(5);
		expect(prompts(harness)).toHaveLength(1);
		// Marker FACTS carry the real OS pid for orphan diagnosis; writing the
		// marker belongs to the collection (the host records nothing here).
		expect(child.markerFacts().pid).toBeNumber();
		autoAcceptPrompt(harness.spawned[0]);
		const snap = await pending;
		expect(snap.state).toBe("running");
		expect(snap.alive).toBe(true);
		expect(child.settled).toBe(false);
	});

	test("withholds the task prompt until the readiness report covers every entry", async () => {
		const { child, harness } = makeChild({
			readinessEntries: { "task-workspace": ["task_status"], reporting: ["report_result"] },
		});
		const pending = child.start();
		await tick(20);
		expect(prompts(harness)).toHaveLength(0);
		confirmReadiness(harness.spawned[0], { tools: ["task_status"] });
		// Missing required tool: fail closed, child killed, task never sent.
		await expect(pending).rejects.toThrow(/readiness handshake failed: entry "reporting" is missing required tools: report_result/);
		expect(harness.spawned[0].signalsReceived).toContain("SIGKILL");
		expect(prompts(harness)).toHaveLength(0);
	});

	test("a complete readiness report dispatches exactly one task prompt", async () => {
		const { child, harness } = makeChild({ readinessEntries: { e: ["t"] } });
		const pending = child.start();
		await tick(10);
		confirmReadiness(harness.spawned[0], { tools: ["t"] });
		confirmReadiness(harness.spawned[0], { tools: ["t"] }); // duplicate is inert
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		expect(prompts(harness)).toHaveLength(1);
		expect(prompts(harness)[0].message).toBe("the task");
	});

	test("readiness timeout kills the child and never sends the task", async () => {
		const { child, harness } = makeChild({
			readinessEntries: { e: ["t"] },
			timeouts: { readinessMs: 40 },
		});
		await expect(child.start()).rejects.toThrow(/readiness handshake did not complete in time/);
		expect(harness.spawned[0].signalsReceived).toContain("SIGKILL");
		expect(prompts(harness)).toHaveLength(0);
	});

	test("abort before the readiness report kills the child without dispatching", async () => {
		const { child, harness, events } = makeChild({ readinessEntries: { e: ["t"] } });
		const controller = new AbortController();
		const pending = child.start(controller.signal);
		await tick(10);
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted before dispatch/);
		expect(prompts(harness)).toHaveLength(0);
		expect(harness.spawned[0].signalsReceived).toContain("SIGKILL");
		expect(events.filter((e) => e.kind === "failed")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "completed")).toHaveLength(0);
	});

	test("a rejected initial prompt rejects the caller and settles failed", async () => {
		const { child, harness, events } = makeChild();
		const pending = child.start();
		await tick(5);
		harness.spawned[0].writeToStdout({
			id: "spawn-prompt",
			type: "response",
			command: "prompt",
			success: false,
			error: "model not found",
		});
		await expect(pending).rejects.toThrow(/child failed to start/);
		await tick(5);
		expect(child.currentState).toBe("failed");
		expect(events.filter((e) => e.kind === "failed")).toHaveLength(1);
		expect(child.terminalFacts()?.failureReason).toContain("initial prompt rejected: model not found");
	});
});

describe("ChildAgentProcess settlement", () => {
	test("settles completed with facts; the caller writes the result", async () => {
		const { child, harness, events, results } = makeChild();
		const pending = child.start();
		await tick(5);
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		expect(child.terminalFacts()).toBeUndefined(); // still running
		expect(child.hasFinalResult()).toBe(false);

		settleRun(harness.spawned[0], "done work");
		await tick(40);
		expect(child.currentState).toBe("completed");
		expect(child.hasFinalResult()).toBe(true);
		const facts = child.terminalFacts()!;
		expect(facts.status).toBe("completed");
		expect(facts.finalText).toBe("done work");
		expect(results.at(-1)?.finalText).toBe("done work");
		expect(events.filter((e) => e.kind === "completed")).toHaveLength(1);
		expect(child.outcome()).toEqual({ status: "completed", summary: "done work" });
	});

	test("cancel after acceptance aborts once and never re-dispatches the task", async () => {
		const { child, harness, events } = makeChild();
		const pending = child.start();
		await tick(5);
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		const proc = harness.spawned[0];

		await child.cancel();
		expect(proc.signalsReceived).toContain("SIGTERM");
		expect(child.currentState).toBe("cancelled");
		// Exactly the initial task prompt: cancellation is an abort, never a
		// second dispatch.
		expect(prompts(harness)).toHaveLength(1);
		expect(proc.commands.filter((c) => c.type === "abort")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "cancelled")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "completed" || e.kind === "failed")).toHaveLength(0);
	});

	test("a pending question is answered once and cannot be answered twice", async () => {
		const { child, harness } = makeChild();
		const pending = child.start();
		await tick(5);
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		harness.spawned[0].writeToStdout({
			type: "extension_ui_request",
			id: "ui-1",
			method: "input",
			title: "ask",
			placeholder: JSON.stringify({ questions: [{ id: "q", question: "which?", options: [{ label: "a" }] }] }),
		});
		await tick(10);
		expect(child.outcome()?.status).toBe("needs_input");
		child.respond("a");
		const answer = harness.spawned[0].lastCommand("extension_ui_response");
		expect(answer).toMatchObject({ id: "ui-1", value: "a" });
		expect(() => child.respond("b")).toThrow(/no pending question/);
		// The pending dialog is cleared, so nothing is reported as waiting.
		expect(child.outcome()).toBeUndefined();
	});
});

describe("ChildAgentProcess independence", () => {
	test("two children keep separate state, facts and events", async () => {
		const a = makeChild();
		const b = makeChild();
		const pendingA = a.child.start();
		const pendingB = b.child.start();
		await tick(5);
		autoAcceptPrompt(a.harness.spawned[0]);
		autoAcceptPrompt(b.harness.spawned[0]);
		await pendingA;
		await pendingB;

		settleRun(a.harness.spawned[0], "A finished");
		await tick(40);

		expect(a.child.currentState).toBe("completed");
		expect(b.child.currentState).toBe("running");
		expect(a.child.outcome()).toEqual({ status: "completed", summary: "A finished" });
		expect(b.child.outcome()).toBeUndefined();
		expect(a.results).toHaveLength(1);
		expect(b.results).toHaveLength(0);
		// Events never cross: every lifecycle event names its own child.
		expect(a.events.every((e) => e.agentId === a.child.id)).toBe(true);
		expect(b.events.every((e) => e.agentId === b.child.id)).toBe(true);
		expect(a.events.filter((e) => e.kind === "completed")).toHaveLength(1);
		expect(b.events.filter((e) => e.kind === "completed")).toHaveLength(0);
	});

	test("cancel returns after SIGKILL even when close never arrives", async () => {
		// A grandchild that inherited stdio can hold the pipes open after
		// the child's death, so 'close' never fires. cancel() must still
		// return (bounded by killGraceMs), or shutdown hangs and the
		// worktree lease held past it is never released.
		const { child, harness } = makeChild({ timeouts: { killGraceMs: 50 } });
		const pending = child.start();
		await tick(5);
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		const proc = harness.spawned[0];
		proc.ignoreSigterm = true;
		proc.neverClose = true;
		const t0 = Date.now();
		await child.cancel();
		const dt = Date.now() - t0;
		expect(proc.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
		expect(dt).toBeLessThan(5000);
	});

	test("a re-dispatch over a terminal state hides the stale result until the new run starts", async () => {
		const { child, harness } = makeChild();
		const pending = child.start();
		await tick(5);
		autoAcceptPrompt(harness.spawned[0]);
		await pending;
		settleRun(harness.spawned[0], "first");
		await tick(40);
		expect(child.hasFinalResult()).toBe(true);

		await child.dispatch("followUp", "keep going");
		expect(child.hasFinalResult()).toBe(false);
		expect(child.outcome()).toBeUndefined();

		// The child proves the new run began: the stale mark clears.
		harness.spawned[0].writeToStdout({ type: "agent_start" });
		await tick(5);
		expect(child.currentState).toBe("running");
		expect(child.hasFinalResult()).toBe(false); // no result for the new run yet
	});
});
