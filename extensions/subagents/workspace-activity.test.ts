/**
 * Unit tests for live operator observability wiring:
 * - controller: authoritative tool activity from child RPC events (T4-T6),
 *   bounded buffers, run-boundary resets, early session identity (T3);
 * - workspace layer: onUpdate emission with stable identity (T1, T2),
 *   refresh cadence without run-semantics drift (T7), and timer cleanup on
 *   done / needs_input / detach (T8).
 *
 * The child is the FakeRpcProcess; no real pi process is involved.
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
	startRun,
} from "./fake-rpc";
import { envelopeFileName, type Envelope } from "./envelope";
import { createWorkspaceLayer } from "./workspace-agent";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- part A: controller level

interface RtHarness {
	runtime: LocalSubagentRuntime;
	spawned: FakeRpcProcess[];
	tmp: string;
	cleanup(): void;
}

function makeRuntime(): RtHarness {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsactivity-test-"));
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
	});
	return {
		runtime,
		spawned: harness.spawned,
		tmp,
		cleanup() {
			fs.rmSync(tmp, { recursive: true, force: true });
		},
	};
}

/** Spawn a generic child over the fake rpc and return snapshot + process. */
async function spawnChild(h: RtHarness) {
	const pending = h.runtime.spawn({ task: "t" });
	for (let i = 0; i < 100 && h.spawned.length === 0; i++) await tick(10);
	const proc = h.spawned[h.spawned.length - 1]!;
	autoAcceptPrompt(proc);
	return { snap: await pending, proc };
}

function writeStart(proc: FakeRpcProcess, ev: Record<string, unknown>): void {
	proc.writeToStdout({ type: "tool_execution_start", ...ev });
}

function writeEnd(proc: FakeRpcProcess, ev: Record<string, unknown>): void {
	proc.writeToStdout({ type: "tool_execution_end", ...ev });
}

describe("controller: live tool activity (T4-T6)", () => {
	test("T4: tool_execution_start opens the active tool with a bounded summary", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			const before = Date.now();
			writeStart(proc, { toolCallId: "t1", toolName: "bash", args: { command: "bun test extensions/subagents" } });
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool?.name).toBe("bash");
			expect(snap.activeTool?.summary).toBe("bun test extensions/subagents");
			expect(snap.activeTool!.startedAt).toBeGreaterThanOrEqual(before);
			expect(snap.activeTool!.startedAt).toBeLessThanOrEqual(Date.now());
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T5: tool_execution_end clears active and appends bounded recent with endedAt", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			writeStart(proc, { toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } });
			writeEnd(proc, { toolCallId: "t1", toolName: "edit" });
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool).toBeUndefined();
			expect(snap.recentActivity).toHaveLength(1);
			expect(snap.recentActivity![0]).toMatchObject({ name: "edit", summary: "a.ts" });
			expect(snap.recentActivity![0]!.endedAt).toBeDefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("parallel tools: newest start is current; ending it demotes the older still-running tool", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			writeStart(proc, { toolCallId: "a", toolName: "read", args: { path: "old.ts" } });
			writeStart(proc, { toolCallId: "b", toolName: "bash", args: { command: "sleep 5" } });
			expect(h.runtime.inspect()[0]!.activeTool?.name).toBe("bash");
			writeEnd(proc, { toolCallId: "b", toolName: "bash" });
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool?.name).toBe("read");
			expect(snap.recentActivity?.map((e) => e.name)).toEqual(["bash"]);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("ends that match no active tool are ignored, never guessed", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			writeEnd(proc, { toolCallId: "nope", toolName: "bash" });
			writeStart(proc, { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
			writeEnd(proc, { toolCallId: "other", toolName: "bash" });
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool?.name).toBe("bash");
			expect(snap.recentActivity ?? []).toHaveLength(0);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T6: recent activity cannot grow without bound (hard cap, keeps the latest)", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			for (let i = 1; i <= 10; i++) {
				writeStart(proc, { toolCallId: `t${i}`, toolName: "bash", args: { command: `cmd-${i}` } });
				writeEnd(proc, { toolCallId: `t${i}`, toolName: "bash" });
			}
			const snap = h.runtime.inspect()[0]!;
			expect(snap.recentActivity!.length).toBeLessThanOrEqual(4);
			expect(snap.recentActivity!.at(-1)?.summary).toBe("cmd-10");
			expect(snap.recentActivity!.at(-1)?.summary).not.toBe("cmd-1");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("agent_start is the run boundary: activity resets per run", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			writeStart(proc, { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
			writeEnd(proc, { toolCallId: "t1", toolName: "bash" });
			startRun(proc); // a new run begins (e.g. steer/follow_up)
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool).toBeUndefined();
			expect(snap.recentActivity).toEqual([]);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("summaries never leak non-allow-listed argument blobs", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			const secret = "SUPER-SECRET-CONTENT-BLOB";
			writeStart(proc, { toolCallId: "t1", toolName: "write", args: { path: "a.ts", content: secret } });
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool?.summary).toBe("a.ts");
			expect(JSON.stringify(snap.activeTool)).not.toContain(secret);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

	describe("controller: early session identity (T3)", () => {
	test("sessionId is available right after prompt acceptance; sessionFile only once settled", async () => {
		const h = makeRuntime();
		try {
			const { snap, proc } = await spawnChild(h);
			const early = proc.commands.find((c) => c.type === "get_state");
			expect(early).toBeDefined();
			// answer it like a real pi would, and consume the command so the
			// settle-time fake helper does not answer the stale entry again
			proc.writeToStdout({
				id: early!.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: "/tmp/early-session.jsonl", sessionId: "early-session" },
			});
			proc.commands.splice(proc.commands.indexOf(early!), 1);
			await tick(10);
			const fresh = h.runtime.inspect(snap.id)[0]!;
			// the id is authoritative immediately; the FILE path is not: pi
			// creates the session file lazily, so an early path could dangle
			expect(fresh.sessionId).toBe("early-session");
			expect(fresh.sessionFile).toBeUndefined();

			// the settle-time refresh completes the pair (file exists by then)
			settleRun(proc, "done text");
			await tick(60);
			const res = await h.runtime.result(snap.id);
			expect(res?.sessionId).toBe("fake-session");
			expect(res?.sessionFile).toBe("/tmp/fake-session.jsonl");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

// ---------------------------------------------- part B: workspace layer level

interface Update {
	text: string;
	at: number;
}

interface Harness {
	runtime: LocalSubagentRuntime;
	spawned: FakeRpcProcess[];
	tmp: string;
	taskRoot: string;
	tool: { def?: { execute: Function } };
	updates: Update[];
	messages: Array<{ message: Record<string, unknown> }>;
	cleanup(): void;
	agentId(): string;
	lastProc(): FakeRpcProcess;
}

const CTX = { model: { provider: "zai", id: "glm-x" }, thinkingLevel: "low", cwd: "/tmp" };

function makeLayer(): Harness {
	const harness = createFakeSpawnFactory();
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "wsobs-test-"));
	const tmp = path.join(base, "results");
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(tmp, { recursive: true });
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const taskRoot = fs.realpathSync(taskRootRaw);
	const previousTaskRoot = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = taskRoot;

	const updates: Update[] = [];
	const messages: Harness["messages"] = [];
	const tool: Harness["tool"] = {};
	const pi = {
		registerTool: (def: { name: string; execute: Function }) => {
			if (def.name === "workspace_agent") tool.def = def;
		},
		sendMessage: (message: Record<string, unknown>) => {
			messages.push({ message });
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
	// Fast refresh cadence so tests observe the loop without real waiting.
	createWorkspaceLayer(pi, () => runtime, { statusRefreshMs: 25 });

	return {
		runtime,
		spawned: harness.spawned,
		tmp,
		taskRoot,
		tool,
		updates,
		messages,
		cleanup() {
			if (previousTaskRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousTaskRoot;
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

/** Build a real linked worktree under the fake task root. */
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

/** Dispatch through the real tool execute, capturing onUpdate into h.updates. */
function dispatch(h: Harness, params: Record<string, unknown>, signal?: AbortSignal) {
	const execute = h.tool.def!.execute as (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		ou: unknown,
		ctx: unknown,
	) => Promise<{ details: Record<string, unknown> }>;
	const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
		const text = u.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		h.updates.push({ text, at: Date.now() });
	};
	return execute("tc-obs", params, signal ?? undefined, onUpdate, CTX);
}

/** Drive a dispatch to a running child: confirm readiness, accept the prompt. */
async function driveToRunning(h: Harness, params: Record<string, unknown>, signal?: AbortSignal) {
	const pending = dispatch(h, params, signal);
	for (let i = 0; i < 100 && h.spawned.length === 0; i++) await tick(20);
	if (h.spawned.length === 0) throw new Error("dispatch never spawned a child");
	const proc = h.lastProc();
	confirmReadiness(proc, "task-workspace", {
		tools: ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"],
	});
	confirmReadiness(proc, "workspace-reporting", { tools: ["report_result"] });
	autoAcceptPrompt(proc);
	await tick(40);
	return { pending, proc };
}

function writeEnvelope(h: Harness, agentId: string): void {
	const envelope: Envelope = {
		status: "done",
		summary: "all good",
		changed_scope: [],
		verification: [],
		gaps: [],
	};
	fs.writeFileSync(
		path.join(h.tmp, envelopeFileName(agentId)),
		JSON.stringify({ agentId, generation: 1, stale: false, reportedAt: Date.now(), envelope }),
	);
}

describe("workspace_agent live updates", () => {
	test("T1/T2: updates emitted after dispatch with stable run identity", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			await tick(60); // at least one refresh tick after the immediate first update
			expect(h.updates.length).toBeGreaterThanOrEqual(1);
			const first = h.updates[0]!.text;
			const agentId = h.agentId();
			expect(first).toMatch(/RepoOwner wr-\d+-[0-9a-z]+/);
			expect(first).toContain(agentId);
			expect(first).toContain(ws);
			expect(first).toContain("running");
			expect(first).toContain("model      zai/glm-x · low");
			// updates are progress UI, not context traffic: no custom messages
			expect(h.messages).toHaveLength(0);

			writeEnvelope(h, agentId);
			settleRun(h.lastProc(), "finished");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done", agentId });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T3: session id appears in updates while the child is still running", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-session-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const proc = h.lastProc();
			const early = proc.commands.find((c) => c.type === "get_state");
			expect(early).toBeDefined();
			proc.writeToStdout({
				id: early!.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: "/tmp/obs-session.jsonl", sessionId: "obs-session-42" },
			});
			await tick(60);
			expect(h.updates.some((u) => u.text.includes("session    obs-session-42"))).toBe(true);

			writeEnvelope(h, h.agentId());
			settleRun(proc, "finished");
			await pending;
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T4/T5: child tool activity surfaces as current, then recent", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-tool-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const proc = h.lastProc();
			proc.writeToStdout({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "bun test extensions/subagents" },
			});
			await tick(60);
			expect(h.updates.some((u) => u.text.includes("current\n  bash · bun test extensions/subagents"))).toBe(true);
			proc.writeToStdout({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
			await tick(60);
			expect(h.updates.some((u) => u.text.includes("recent\n  bash · bun test extensions/subagents"))).toBe(true);

			writeEnvelope(h, h.agentId());
			settleRun(proc, "finished");
			await pending;
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T7: repeated refresh updates elapsed time without mutating run semantics", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-refresh-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const count0 = h.updates.length;
			await tick(1200); // cross the one-second elapsed boundary at 25ms cadence
			expect(h.updates.length).toBeGreaterThan(count0);
			expect(new Set(h.updates.map((u) => u.text)).size).toBeGreaterThanOrEqual(2); // elapsed moved
			// run semantics untouched: query-mode still reports a running run
			const runId = h.updates[0]!.text.match(/RepoOwner (wr-\d+-[0-9a-z]+)/)![1]!;
			const queryExecute = h.tool.def!.execute as Function;
			const q = (await queryExecute("tc-q", { run_id: runId }, undefined, undefined, CTX)) as {
				details: Record<string, unknown>;
			};
			expect(q.details).toMatchObject({ status: "running", runId, dispatched: true });

			writeEnvelope(h, h.agentId());
			settleRun(h.lastProc(), "finished");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T8: update loop stops after terminal done — no leaked timers", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-done-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId);
			settleRun(h.lastProc(), "finished");
			const res = await pending;
			expect(res.details.status).toBe("done");
			const count = h.updates.length;
			await tick(150); // several refresh intervals at 25ms
			expect(h.updates.length).toBe(count); // frozen
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T8: update loop stops at needs_input", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-ask-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			h.lastProc().writeToStdout({
				type: "extension_ui_request",
				id: "ui-obs-1",
				method: "input",
				title: "ask",
				placeholder: JSON.stringify({ questions: [{ id: "q", question: "Proceed?", options: [{ label: "yes" }] }] }),
			});
			const res = await pending;
			expect(res.details.status).toBe("needs_input");
			const count = h.updates.length;
			await tick(150);
			expect(h.updates.length).toBe(count); // frozen

			// the run continues: respond, report, settle (deadline still armed)
			await h.runtime.respond(h.agentId(), "yes");
			writeEnvelope(h, h.agentId());
			settleRun(h.lastProc(), "finished after answer");
			await tick(120);
			const done = h.messages.find((m) => String(m.message.content ?? "").includes("[workspace_agent completed]"));
			expect(done).toBeDefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("T8: update loop stops on detach — run keeps going under its deadline", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-detach-ws");
			const ac = new AbortController();
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" }, ac.signal);
			await tick(60);
			ac.abort();
			const res = await pending;
			expect(res.details.status).toBe("running"); // detached, not cancelled
			const count = h.updates.length;
			await tick(150);
			expect(h.updates.length).toBe(count); // frozen after detach

			// the run still completes on its own and stays queryable
			const agentId = h.agentId();
			writeEnvelope(h, agentId);
			settleRun(h.lastProc(), "finished while detached");
			await tick(120);
			const done = h.messages.find((m) => String(m.message.content ?? "").includes("[workspace_agent completed]"));
			expect(done).toBeDefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});
