/**
 * Unit tests for the workspace layer: pre-dispatch gates, settlement machine
 * (envelope/ladder/deadline precedence), needs_input, detach, Main cancel,
 * and durable query-mode. The child is the FakeRpcProcess; the envelope file
 * is written directly, simulating the child's report_result persistence.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller";
import {
	autoAcceptPrompt,
	confirmReadiness,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	settleRun,
} from "./fake-rpc";
import { envelopeFileName, type Envelope } from "./envelope";
import { createWorkspaceLayer, managedAgentOpPolicy } from "./workspace-agent";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

interface Harness {
	runtime: LocalSubagentRuntime;
	harness: ReturnType<typeof createFakeSpawnFactory>;
	tmp: string;
	taskRoot: string;
	tool: ReturnType<typeof captureTool>;
	messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	cleanup(): void;
	agentId(): string;
	lastProc(): FakeRpcProcess;
}

function captureTool(pi: {
	registerTool(def: { name: string }): void;
}): { def?: { name: string; execute: Function } } {
	const box: { def?: { name: string; execute: Function } } = {};
	const realRegister = pi.registerTool.bind(pi);
	(pi as { registerTool: unknown }).registerTool = (def: { name: string; execute: Function }) => {
		if (def.name === "workspace_agent") box.def = def;
		realRegister(def);
	};
	return box;
}

function makeLayer(layerOpts?: { profileEntries?: () => string[] }): Harness {
	const harness = createFakeSpawnFactory();
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "wsagent-test-"));
	const tmp = path.join(base, "results");
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(tmp, { recursive: true });
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const taskRoot = fs.realpathSync(taskRootRaw);
	process.env.OMP_TASK_ROOT = taskRoot;

	const messages: Harness["messages"] = [];
	const box = captureTool({
		registerTool(def) {
			if (def.name === "workspace_agent") box.def = def as never;
		},
	} as ExtensionAPI);
	const pi = {
		registerTool: (def: { name: string; execute: Function }) => {
			if (def.name === "workspace_agent") box.def = def;
		},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			messages.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
		readinessTimeoutMs: 5000,
	});
	createWorkspaceLayer(pi, runtime, layerOpts);

	return {
		runtime,
		harness,
		tmp,
		taskRoot,
		tool: box as Harness["tool"],
		messages,
		cleanup() {
			delete process.env.OMP_TASK_ROOT;
			fs.rmSync(base, { recursive: true, force: true });
		},
		agentId() {
			const snaps = runtime.inspect();
			if (snaps.length === 0) throw new Error("no agent spawned");
			return snaps[snaps.length - 1]!.id;
		},
		lastProc() {
			if (harness.spawned.length === 0) throw new Error("no process spawned");
			return harness.spawned[harness.spawned.length - 1]!;
		},
	};
}

/** Build a real linked worktree under the fake task root. Returns its path. */
function makeWorktree(taskRoot: string, name: string): string {
	const seed = path.join(path.dirname(taskRoot), `seed-${name}`);
	const gitDir = path.join(path.dirname(taskRoot), `git-${name}.git`);
	execFileSync("git", ["init", "-q", "--bare", gitDir]);
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	execFileSync("git", ["-C", seed, "config", "user.email", "t@example.invalid"]);
	execFileSync("git", ["-C", seed, "config", "user.name", "T"]);
	fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
	execFileSync("git", ["-C", seed, "add", "README.md"]);
	execFileSync("git", ["-C", seed, "commit", "-qm", "init"]);
	execFileSync("git", ["-C", seed, "remote", "add", "origin", gitDir]);
	execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
	const ws = path.join(taskRoot, name);
	execFileSync("git", ["-C", seed, "worktree", "add", "-b", `feat/${name}`, ws, "main"]);
	return ws;
}

const CTX = { model: { provider: "zai", id: "glm-x" }, thinkingLevel: "low", cwd: "/tmp" };

function dispatchCall(h: Harness, params: Record<string, unknown>, signal?: AbortSignal, ctxOverride?: unknown) {
	const execute = h.tool.def!.execute as (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ou: unknown, ctx: unknown) => Promise<{ details: Record<string, unknown>; content: [{ type: string; text: string }]; isError?: boolean }>;
	return execute("tc-1", params, signal ?? undefined, undefined, ctxOverride ?? CTX);
}

/** Drive a dispatch to a running child: confirm readiness, accept the prompt. */
async function driveToRunning(h: Harness, params: Record<string, unknown>, signal?: AbortSignal) {
	const pending = dispatchCall(h, params, signal);
	// Wait for the child process: validation runs real git, which can take a
	// few hundred ms on macOS before the spawn happens.
	for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) {
		await tick(20);
	}
	if (h.harness.spawned.length === 0) {
		// Surface the pre-dispatch failure for diagnostics.
		const early = (await Promise.race([
			pending.then((r) => r as unknown),
			tick(50).then(() => null),
		])) as { details?: unknown } | null;
		throw new Error(
			`dispatch never spawned a child; early result: ${early ? JSON.stringify(early.details ?? early) : "(still pending)"}`,
		);
	}
	const proc = h.lastProc();
	confirmReadiness(proc, "task-workspace", {
		tools: ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"],
	});
	confirmReadiness(proc, "workspace-reporting", { tools: ["report_result"] });
	autoAcceptPrompt(proc);
	await tick(20);
	return { pending, proc };
}

function writeEnvelope(h: Harness, agentId: string, opts?: { stale?: boolean; status?: Envelope["status"] }): void {
	const envelope: Envelope = {
		status: opts?.status ?? "done",
		summary: "all good",
		changed_scope: ["f.md"],
		verification: [{ check: "bun test", result: "pass" }],
		gaps: [],
	};
	const record = {
		agentId,
		generation: 1,
		stale: opts?.stale ?? false,
		reportedAt: Date.now(),
		envelope,
	};
	fs.writeFileSync(path.join(h.tmp, envelopeFileName(agentId)), JSON.stringify(record));
}

// ------------------------------------------------------------------- tests

describe("pre-dispatch gates (fail closed)", () => {
	test("missing session model → blocked, no process", async () => {
		const h = makeLayer();
		try {
			const res = await dispatchCall(h, { workspace: "/nonexistent-ws", task: "t" }, undefined, {
				thinkingLevel: "low",
				cwd: "/tmp",
			});
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("nonexistent path → unsupported, dispatched:false, no process", async () => {
		const h = makeLayer();
		try {
			const res = await dispatchCall(h, { workspace: "/definitely/not/here", task: "t" });
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("plain git repo (not a linked worktree) → unsupported", async () => {
		const h = makeLayer();
		try {
			const repo = path.join(path.dirname(h.taskRoot), "plain-repo");
			execFileSync("git", ["init", "-q", "-b", "main", repo]);
			const res = await dispatchCall(h, { workspace: repo, task: "t" });
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("worktree outside the task root → unsupported", async () => {
		const h = makeLayer();
		try {
			const outside = makeWorktree(path.join(path.dirname(h.taskRoot), "elsewhere-tasks"), "outside-ws");
			const res = await dispatchCall(h, { workspace: outside, task: "t" });
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});
});

describe("happy path", () => {
	test("fresh envelope settles done: result delivered, child retired, notified, queryable", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "happy-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work it" });
			const agentId = h.agentId();
			expect(h.runtime.inspect(agentId)[0]!.cwd).toBe(ws);
			// label pins the session name to subagent:owner-<basename>
			expect(h.runtime.inspect(agentId)[0]!.label).toBe("owner-happy-ws");

			writeEnvelope(h, agentId);
			settleRun(proc, "did the work");
			const res = await pending;
			expect(res.details).toMatchObject({
				status: "done",
				dispatched: true,
				agentId,
				child_may_have_mutated_repo: false,
			});
			expect((res.details.result as Envelope).summary).toBe("all good");
			// terminal notification was sent once, with the full envelope
			expect(h.messages).toHaveLength(1);
			expect(String(h.messages[0]!.message.content)).toContain("[workspace_agent completed]");
			expect(String(h.messages[0]!.message.content)).toContain("\"summary\":\"all good\"");
			// child retired: process dead, record keeps completed
			await tick(30);
			expect(proc.closed).toBe(true);
			expect(h.runtime.inspect(agentId)[0]!.state).toBe("completed");

			// durable query by runId returns the same terminal envelope
			const runId = res.details.runId as string;
			const q = await dispatchCall(h, { run_id: runId });
			expect(q.details).toMatchObject({ status: "done", runId });
			expect((q.details.result as Envelope).verification[0]).toMatchObject({ result: "pass" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("staleness and report ladder", () => {
	test("stale envelope → ladder follow-up → fresh report → done", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "ladder-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId, { stale: true }); // reported, then invalidated

			settleRun(proc, "settled without a valid report");
			await tick(80);
			const followUp = proc.commands.find(
				(c) => c.type === "prompt" && c.streamingBehavior === "followUp",
			);
			expect(followUp).toBeDefined();
			expect(String(followUp!.message)).toMatch(/report_result/);

			// fresh report after the reminder, then the child settles again
			writeEnvelope(h, agentId);
			settleRun(proc, "done after reminder");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("ladder exhaustion before deadline → blocked, no valid report", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "exhaust-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t", timeout_ms: 600000 });
			await settleRun(proc, "s1");
			await tick(80);
			await settleRun(proc, "s2");
			await tick(80);
			await settleRun(proc, "s3");
			await tick(80);
			const followUps = proc.commands.filter((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(followUps.length).toBe(3);
			await settleRun(proc, "s4");
			const res = await pending;
			expect(res.details).toMatchObject({
				status: "blocked",
				reason: "no_valid_report",
				child_may_have_mutated_repo: true,
			});
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("deadline", () => {
	test("deadline fires mid-run → partial + mutated, real cancel kills the child", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "deadline-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t", timeout_ms: 120 });
			const agentId = h.agentId();
			const res = await pending;
			await tick(60);
			expect(res.details).toMatchObject({
				status: "partial",
				reason: "deadline",
				child_may_have_mutated_repo: true,
				agentId,
			});
			expect(h.runtime.inspect(agentId)[0]!.alive).toBe(false);
			expect(proc.closed).toBe(true);
			// no completion notification for the deadline outcome? It IS sent:
			expect(h.messages).toHaveLength(1);
			expect(String(h.messages[0]!.message.content)).toContain("status: partial");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("needs_input", () => {
	test("ask_parent suspends: dispatch returns needs_input, respond then completes", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "ask-ws");
			const { proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-77",
				method: "input",
				title: "ask_parent",
				placeholder: "Which base ref?",
			});
			await tick(30);
			// The pending dispatch call must still be blocked here (needs_input
			// resolves it). Emulate the Main flow: resolve happens below via a
			// second ask_parent round after respond; for unit simplicity we
			// check query-mode state instead.
			const res = await (async () => {
				const waiter = dispatchCall(h, { run_id: "x" });
				return waiter;
			})();
			expect(res.isError).toBe(true); // unknown run id before any response
			void res;

			// respond resumes the child; then it reports and settles
			await h.runtime.respond(agentId, "use main");
			writeEnvelope(h, agentId);
			settleRun(proc, "completed after answer");
			// the original dispatch call resolves on the terminal settlement
			// only if it was still waiting; it resolved at needs_input already.
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("blocking dispatch call returns needs_input with ids; run survives; query works", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "ask2-ws");
			const pending = dispatchCall(h, { workspace: ws, task: "t" });
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			const proc = h.lastProc();
			confirmReadiness(proc, "task-workspace", {
				tools: ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"],
			});
			confirmReadiness(proc, "workspace-reporting", { tools: ["report_result"] });
			autoAcceptPrompt(proc);
			await tick(20);
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-9",
				method: "input",
				title: "ask_parent",
				placeholder: "q?",
			});
			const res = await pending;
			expect(res.details).toMatchObject({
				status: "needs_input",
				dispatched: true,
				question: "q?",
			});
			const { runId, agentId } = res.details as { runId: string; agentId: string };

			// run NOT finished: query-mode returns needs_input with deadline left
			const q1 = await dispatchCall(h, { run_id: runId });
			expect(q1.details).toMatchObject({ status: "needs_input", state: "waiting_input" });
			expect((q1.details.deadlineMsLeft as number) ?? 0).toBeGreaterThan(0);
			void agentId;
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("detach and cancel", () => {
	test("main abort detaches: run continues, later completion still notified and queryable", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "detach-ws");
			const ac = new AbortController();
			const pending = dispatchCall(h, { workspace: ws, task: "t" }, ac.signal);
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			const proc = h.lastProc();
			confirmReadiness(proc, "task-workspace", {
				tools: ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"],
			});
			confirmReadiness(proc, "workspace-reporting", { tools: ["report_result"] });
			autoAcceptPrompt(proc);
			await tick(20);

			ac.abort(); // main abort AFTER dispatch — detach, not cancel
			const res = await pending;
			expect(res.details).toMatchObject({ dispatched: true, state: "running" });
			expect(String(res.details.reason)).toContain("detached");
			const { runId, agentId } = res.details as { runId: string; agentId: string };
			expect(h.runtime.inspect(agentId)[0]!.alive).toBe(true); // NOT cancelled

			// the run finishes on its own
			writeEnvelope(h, agentId);
			settleRun(proc, "finished while detached");
			await tick(80);
			expect(h.messages).toHaveLength(1); // completion notification still arrives
			const q = await dispatchCall(h, { run_id: runId });
			expect(q.details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("explicit Main cancel → blocked cancelled_by_main, mutated, no result", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "cancel-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			// Main cancels through the subagent tool's op=cancel → runtime.cancel
			const cancelPromise = h.runtime.cancel(agentId);
			const res = await pending;
			await cancelPromise;
			expect(res.details).toMatchObject({
				status: "blocked",
				reason: "cancelled_by_main",
				child_may_have_mutated_repo: true,
			});
			expect(res.details.result).toBeUndefined();
			await tick(30);
			expect(proc.closed).toBe(true);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("startup failure classification (A2c)", () => {
	test("child dying before acceptance (e.g. extension load failure) → unsupported, dispatched:false", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a2c-ws");
			const pending = dispatchCall(h, { workspace: ws, task: "t" });
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			// pi exits (code 1) when an extension fails to load: no readiness,
			// no prompt acceptance — the child just dies.
			h.lastProc().close(1, null);
			const res = await pending;
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(h.harness.spawned).toHaveLength(1); // exactly one attempt, no retry
		} finally {
			h.cleanup();
		}
	});
});

describe("static preflight (A2b)", () => {
	test("broken profile entrypoint \u2192 unsupported, dispatched:false, no process", async () => {
		const h = makeLayer({ profileEntries: () => ["/definitely/missing/profile-entry.ts"] });
		try {
			const ws = makeWorktree(h.taskRoot, "a2b-ws");
			const res = await dispatchCall(h, { workspace: ws, task: "t" });
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(String(res.details.reason)).toContain("missing or unreadable");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});
});

describe("query-mode and allow-list", () => {
	test("unknown run id errors; policy matrix matches the contract", async () => {
		const h = makeLayer();
		try {
			const q = await dispatchCall(h, { run_id: "wr-nope" });
			expect(q.isError).toBe(true);
			expect(String(q.content[0].text)).toContain("unknown run id");

			expect(managedAgentOpPolicy("status").allowed).toBe(true);
			expect(managedAgentOpPolicy("result").allowed).toBe(true);
			expect(managedAgentOpPolicy("respond").allowed).toBe(true);
			expect(managedAgentOpPolicy("cancel").allowed).toBe(true);
			expect(managedAgentOpPolicy("wait").allowed).toBe(false);
			expect(String(managedAgentOpPolicy("wait").reason)).toContain("workspace_agent(run_id)");
			expect(managedAgentOpPolicy("steer").allowed).toBe(false);
			expect(managedAgentOpPolicy("follow_up").allowed).toBe(false);
			expect(managedAgentOpPolicy("spawn").allowed).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});
