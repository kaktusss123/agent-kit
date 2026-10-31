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
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller.ts";
import {
	autoAcceptPrompt,
	confirmReadiness,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	settleRun,
	startRun,
} from "./fake-rpc.ts";
import { envelopeFileName, type Envelope } from "./envelope.ts";
import { createWorkspaceRuns, type WorkspaceRuns } from "./workspace-runs.ts";
import { loadResult } from "./result-store.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * Await the ACTUAL delivery of a matching pi message (the production event)
 * instead of sampling the mailbox once after a fixed sleep: the settle chain
 * (retire + real-git settled-state reads in readGitState) takes a
 * machine-dependent ~200ms+, so a fixed tick() is a race.
 */
async function waitForMessage(
	messages: Harness["messages"],
	predicate: (m: Harness["messages"][number]) => boolean,
	deadlineMs = 5000,
): Promise<Harness["messages"][number] | undefined> {
	const step = 10;
	for (let waited = 0; ; waited += step) {
		const found = messages.find(predicate);
		if (found) return found;
		if (waited >= deadlineMs) return undefined;
		await tick(step);
	}
}

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

	test("record.cwd is passed as workspace: `cd <cwd> && …` collapses in the summary", async () => {
		const h = makeRuntime();
		try {
			const { proc } = await spawnChild(h);
			writeStart(proc, {
				toolCallId: "t1",
				toolName: "bash",
				args: { command: `cd ${h.tmp} && git status` },
			});
			const snap = h.runtime.inspect()[0]!;
			expect(snap.activeTool?.summary).toBe("git status");
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
	test("sessionId is early; sessionFile appears mid-run only after the reported file exists", async () => {
		const h = makeRuntime();
		try {
			const { snap, proc } = await spawnChild(h);
			const early = proc.commands.find((c) => c.type === "get_state");
			expect(early).toBeDefined();
			const reportedFile = path.join(h.tmp, "early-session.jsonl");
			// Consume the early command so settleRun answers only the terminal one.
			proc.writeToStdout({
				id: early!.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: reportedFile, sessionId: "early-session" },
			});
			proc.commands.splice(proc.commands.indexOf(early!), 1);
			const fresh = h.runtime.inspect(snap.id)[0]!;
			expect(fresh.sessionId).toBe("early-session");
			expect(fresh.sessionFile).toBeUndefined();
			expect(JSON.stringify(fresh)).not.toContain(reportedFile); // candidate stays private
			// A directory at the authoritative path is not a transcript either.
			fs.mkdirSync(reportedFile);
			expect(h.runtime.inspect(snap.id)[0]!.sessionFile).toBeUndefined();
			fs.rmdirSync(reportedFile);
			// Persistence may happen after message_end: a later inspection must
			// promote the SAME Pi-reported path without another get_state request.
			proc.writeToStdout({ type: "message_end", message: { role: "assistant" } });
			expect(h.runtime.inspect(snap.id)[0]!.sessionFile).toBeUndefined();
			const stateRequests = proc.commands.filter((c) => c.type === "get_state").length;
			fs.writeFileSync(reportedFile, "{\"type\":\"session\"}\n");
			const live = h.runtime.inspect(snap.id)[0]!;
			expect(live.state).toBe("running");
			expect(live.sessionFile).toBe(reportedFile);
			expect(proc.commands.filter((c) => c.type === "get_state")).toHaveLength(stateRequests);

			// Terminal get_state remains authoritative for fake settle compatibility.
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
	runs: WorkspaceRuns;
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
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(base, "agent-dir");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

	const updates: Update[] = [];
	const messages: Harness["messages"] = [];
	const pi = {
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
	const runs = createWorkspaceRuns(pi, () => runtime, { statusRefreshMs: 25 });

	return {
		runtime,
		spawned: harness.spawned,
		tmp,
		taskRoot,
		runs,
		updates,
		messages,
		cleanup() {
			if (previousTaskRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousTaskRoot;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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

/** Dispatch a workspace spawn, capturing onUpdate into h.updates. */
function dispatch(h: Harness, params: Record<string, unknown>, signal?: AbortSignal) {
	const onUpdate = (u: { content: Array<{ type: string; text: string }> }) => {
		const text = u.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		h.updates.push({ text, at: Date.now() });
	};
	return h.runs.spawnRun({
		workspace: params.workspace as string,
		task: params.task as string,
		deadlineSec: params.timeout_ms !== undefined ? (params.timeout_ms as number) / 1000 : undefined,
		signal,
		onUpdate,
		sessionModel: CTX.model,
		thinkingLevel: CTX.thinkingLevel,
		cwd: CTX.cwd,
	}) as Promise<{ details: Record<string, unknown> }>;
}

/** Drive a dispatch to a running child: confirm readiness, accept the prompt. */
async function driveToRunning(h: Harness, params: Record<string, unknown>, signal?: AbortSignal) {
	const pending = dispatch(h, params, signal);
	for (let i = 0; i < 100 && h.spawned.length === 0; i++) await tick(20);
	if (h.spawned.length === 0) throw new Error("dispatch never spawned a child");
	const proc = h.lastProc();
	confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
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

describe("workspace run live updates", () => {
	test("T1/T2: updates emitted after dispatch with stable run identity", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			await tick(60); // at least one refresh tick after the immediate first update
			expect(h.updates.length).toBeGreaterThanOrEqual(1);
			const first = h.updates[0]!.text;
			const agentId = h.agentId();
			expect(first).toMatch(/RepoOwner sa-\d+-[0-9a-z]+/);
			expect(first).toContain(agentId);
			// meta row shows the workspace basename, not the full path
			expect(first).toContain(path.basename(ws));
			expect(first).not.toContain(ws);
			expect(first).toContain("running");
			expect(first).toContain("zai/glm-x · low");
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

	test("T3: workspace inspection exposes Pi's file mid-run, not in the progress card", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-session-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const proc = h.lastProc();
			const early = proc.commands.find((c) => c.type === "get_state");
			expect(early).toBeDefined();
			const reportedFile = path.join(h.tmp, "obs-session.jsonl");
			proc.writeToStdout({
				id: early!.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { sessionFile: reportedFile, sessionId: "obs-session-42" },
			});
			proc.commands.splice(proc.commands.indexOf(early!), 1);
			expect(h.runtime.inspect(h.agentId())[0]!.sessionFile).toBeUndefined();
			proc.writeToStdout({ type: "message_end", message: { role: "assistant" } });
			fs.writeFileSync(reportedFile, "{\"type\":\"session\"}\n");
			const stateRequests = proc.commands.filter((c) => c.type === "get_state").length;
			const live = h.runtime.inspect(h.agentId())[0]!;
			expect(live.state).toBe("running");
			expect(live.sessionFile).toBe(reportedFile);
			expect(h.runs.runView(h.agentId())?.state).toBe("running");
			expect(proc.commands.filter((c) => c.type === "get_state")).toHaveLength(stateRequests);
			await tick(60);
			// The progress card still omits session rows; inspection owns them.
			expect(h.updates.length).toBeGreaterThanOrEqual(1);
			expect(h.updates.some((u) => u.text.includes("obs-session-42"))).toBe(false);

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
			expect(h.updates.some((u) => u.text.includes("▸ bash · bun test extensions/subagents"))).toBe(true);
			proc.writeToStdout({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
			await tick(60);
			expect(h.updates.some((u) => / {2}bash · bun test extensions\/subagents · \d+s/.test(u.text))).toBe(true);

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
			await tick(2500); // cross two one-second elapsed boundaries at 25ms cadence
			expect(h.updates.length).toBeGreaterThan(count0);
			expect(new Set(h.updates.map((u) => u.text)).size).toBeGreaterThanOrEqual(2); // elapsed moved
			// run semantics untouched: the registry still reports a running run
			const view = h.runs.runView(h.agentId())!;
			expect(view.state).toBe("running");
			expect(view.deadlineMsLeft).toBeGreaterThan(0);

			writeEnvelope(h, h.agentId());
			settleRun(h.lastProc(), "finished");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}); // ~5.9s of mandatory wall time (driveToRunning + 2500ms two-boundary tick) exceeds bun's 5s default

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
			const done = await waitForMessage(h.messages, (m) =>
				String(m.message.content ?? "").includes("[subagent completed]"),
			);
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
			const done = await waitForMessage(h.messages, (m) =>
				String(m.message.content ?? "").includes("[subagent completed]"),
			);
			expect(done).toBeDefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("lastAssistantText: workspace owner's public speech rides the snapshot root and survives settlement", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "obs-lasttext-ws");
			const { pending } = await driveToRunning(h, { workspace: ws, task: "work" });
			const agentId = h.agentId();
			const proc = h.lastProc();
			expect(h.runtime.inspect(agentId)[0]!.lastAssistantText).toBeUndefined();
			proc.writeToStdout({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "thinking", thinking: "hidden reasoning" },
						{ type: "text", text: "  Environment and spec are clear;\nrunning the focused tests now." },
						{ type: "toolCall", id: "tc", name: "bash" },
					],
				},
			});
			// Live snapshot root (the seam the narrow inspection reads): the text
			// is normalized, thinking/tool calls never enter.
			expect(h.runtime.inspect(agentId)[0]!.lastAssistantText).toEqual({
				text: "Environment and spec are clear; running the focused tests now.",
				updatedAt: expect.any(Number),
			});
			// Running marker persisted on the accepted change.
			expect(loadResult(agentId, h.tmp)).toMatchObject({
				status: "running",
				lastAssistantText: { text: "Environment and spec are clear; running the focused tests now." },
			});

			writeEnvelope(h, agentId);
			settleRun(proc, "finished");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
			// Terminal record keeps the fragment; the run projection stays a
			// separate channel (no lastAssistantText inside run).
			const persisted = loadResult(agentId, h.tmp)!;
			expect(persisted.lastAssistantText!.text).toBe("Environment and spec are clear; running the focused tests now.");
			expect(persisted.run).toMatchObject({ state: "settled" });
			expect("lastAssistantText" in persisted.run!).toBe(false);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});
