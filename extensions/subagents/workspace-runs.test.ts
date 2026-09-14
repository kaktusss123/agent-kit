/**
 * Unit tests for workspace-mode subagent spawns: pre-dispatch gates,
 * settlement machine (envelope/ladder/deadline precedence), needs_input,
 * detach, Main cancel, and durable query via the run registry. The child is
 * the FakeRpcProcess; the envelope file is written directly, simulating the
 * child's report_result persistence.
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
import {
	createWorkspaceRuns,
	defaultProfileEntries,
	managedAgentOpPolicy,
	type WorkspaceRuns,
} from "./workspace-runs";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

interface Harness {
	runtime: LocalSubagentRuntime;
	harness: ReturnType<typeof createFakeSpawnFactory>;
	runs: WorkspaceRuns;
	tmp: string;
	taskRoot: string;
	messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	cleanup(): void;
	agentId(): string;
	lastProc(): FakeRpcProcess;
}

function makeLayer(layerOpts?: { profileEntries?: () => string[]; killGraceMs?: number }): Harness {
	const harness = createFakeSpawnFactory();
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "wsagent-test-"));
	const tmp = path.join(base, "results");
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(tmp, { recursive: true });
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const taskRoot = fs.realpathSync(taskRootRaw);
	// Pin the task root for the layer under test: AGENT_TASK_ROOT is set
	// to the fixture, proving the override feeds the layer (and that an
	// ambient value cannot leak). Restored in cleanup().
	const previousGeneric = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = taskRoot;

	const messages: Harness["messages"] = [];
	const pi = {
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
		killGraceMs: layerOpts?.killGraceMs ?? 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
		readinessTimeoutMs: 5000,
	});
	const runs = createWorkspaceRuns(pi, () => runtime, layerOpts);

	return {
		runtime,
		harness,
		runs,
		tmp,
		taskRoot,
		messages,
		cleanup() {
			if (previousGeneric === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousGeneric;
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
	const ctx = (ctxOverride ?? CTX) as { model?: { provider: string; id: string }; thinkingLevel?: string; cwd?: string };
	return h.runs.spawnRun({
		workspace: params.workspace as string,
		task: params.task as string,
		deadlineSec: params.timeout_ms !== undefined ? (params.timeout_ms as number) / 1000 : undefined,
		signal,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		cwd: ctx.cwd,
	});
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

function writeEnvelope(
	h: Harness,
	agentId: string,
	opts?: { stale?: boolean; status?: Envelope["status"]; generation?: number },
): void {
	const envelope: Envelope = {
		status: opts?.status ?? "done",
		summary: "all good",
		changed_scope: ["f.md"],
		verification: [{ check: "bun test", result: "pass" }],
		gaps: [],
	};
	const record = {
		agentId,
		generation: opts?.generation ?? 1,
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
			expect(String(h.messages[0]!.message.content)).toContain("[subagent completed]");
			expect(String(h.messages[0]!.message.content)).toContain("\"summary\":\"all good\"");
			// child retired: process dead, record keeps completed
			await tick(30);
			expect(proc.closed).toBe(true);
			expect(h.runtime.inspect(agentId)[0]!.state).toBe("completed");

			// the run registry still returns the same terminal envelope by agentId
			const view = h.runs.runView(agentId)!;
			expect(view.terminal).toMatchObject({ status: "done" });
			expect((view.terminal!.result as Envelope).verification[0]).toMatchObject({ result: "pass" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("settled-state verification (A3)", () => {
	test("clean worktree + fresh done report → done, with runtime-read git facts", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-clean-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId);
			settleRun(proc, "did the work");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done", child_may_have_mutated_repo: false });
			const facts = res.details.git_facts as { branch: string; headSha: string; dirty: { staged: string[]; unstaged: string[] } };
			expect(facts.branch).toBe("feat/a3-clean-ws");
			expect(facts.headSha).toBe(execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
			expect(facts.dirty).toMatchObject({ staged: [], unstaged: [] });
			// the completion notification carries the same objective facts
			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			expect(String(note?.message.content)).toContain("branch=feat/a3-clean-ws");
			expect(String(note?.message.content)).toContain("dirty=clean");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("dirty worktree + done report → blocked (not done), reason names the dirt", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-dirty-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId); // child reported done, then a run left changes behind
			fs.appendFileSync(path.join(ws, "README.md"), "verification leftover\n");
			fs.writeFileSync(path.join(ws, "scratch.txt"), "untracked artifact\n");
			settleRun(proc, "claimed done");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "blocked", child_may_have_mutated_repo: true });
			expect(res.details.result).toBeUndefined(); // done was rejected: no trusted result
			expect(String(res.details.reason)).toContain("done_rejected_dirty_worktree");
			expect(String(res.details.reason)).toContain("README.md");
			const facts = res.details.git_facts as { dirty: { unstaged: string[] } };
			expect(facts.dirty.unstaged).toContain("README.md");
			expect(facts.dirty.unstaged).toContain("scratch.txt");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("owner committed the candidate → clean tree → done at the new HEAD", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-commit-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			// the owner's candidate commit (normally via checkpoint_commit)
			fs.writeFileSync(path.join(ws, "impl.txt"), "work\n");
			execFileSync("git", ["-C", ws, "add", "impl.txt"]);
			execFileSync("git", ["-C", ws, "commit", "-qm", "candidate"]);
			const sha = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			writeEnvelope(h, agentId);
			settleRun(proc, "candidate committed and verified");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done", child_may_have_mutated_repo: false });
			expect((res.details.git_facts as { headSha: string }).headSha).toBe(sha);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("git state unreadable → fail closed: blocked (not done)", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-gone-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId);
			fs.rmSync(ws, { recursive: true, force: true }); // worktree vanished after the report
			settleRun(proc, "claimed done");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "blocked", child_may_have_mutated_repo: true });
			expect(res.details.result).toBeUndefined();
			expect(String(res.details.reason)).toContain("done_rejected_unreadable_git_state");
			expect(res.details.git_facts).toBeUndefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("partial envelope over a dirty tree settles done with result.status=partial", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-partial-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			writeEnvelope(h, h.agentId(), { status: "partial" }); // unfinished work may stay dirty
			fs.appendFileSync(path.join(ws, "README.md"), "unfinished\n");
			settleRun(proc, "ran out of time");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done", child_may_have_mutated_repo: false });
			expect((res.details.result as Envelope).status).toBe("partial");
			expect(res.details.git_facts).toBeDefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("blocked envelope keeps working: settles done with result.status=blocked", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "a3-blockedenv-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			writeEnvelope(h, h.agentId(), { status: "blocked" });
			settleRun(proc, "could not proceed");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
			expect((res.details.result as Envelope).status).toBe("blocked");
			expect(res.details.git_facts).toBeDefined();
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

	test("F6: a newer report generation resets the ladder", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "genreset-ws");
			const { proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();

			// settle without any report → ladder reminder #1
			settleRun(proc, "s1");
			await tick(80);
			let followUps = proc.commands.filter((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(followUps.length).toBe(1);
			expect(String(followUps[0]!.message)).toContain("1 of 3");

			// child reports (generation 1) but a later tool call invalidates it
			writeEnvelope(h, agentId, { stale: true, generation: 1 });
			settleRun(proc, "s2");
			await tick(80);
			// ladder was RESET by generation 1: the next reminder is #1 again,
			// not #2
			followUps = proc.commands.filter((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(followUps.length).toBe(2);
			expect(String(followUps[1]!.message)).toContain("1 of 3");

			// same generation going stale again does NOT reset: next is #2
			settleRun(proc, "s3");
			await tick(80);
			followUps = proc.commands.filter((c) => c.type === "prompt" && c.streamingBehavior === "followUp");
			expect(followUps.length).toBe(3);
			expect(String(followUps[2]!.message)).toContain("2 of 3");
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
	test("structured ask suspends: dispatch returns needs_input, respond then completes", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "ask-ws");
			const { proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-77",
				method: "input",
				title: "ask",
				placeholder: JSON.stringify({ questions: [{ id: "base", question: "Which base ref?", options: [{ label: "main" }, { label: "develop" }], recommended: 1 }] }),
			});
			await tick(30);
			// The pending dispatch call must still be blocked here (needs_input
			// resolves it). The unknown-id path of the run registry is checked
			// for diagnostics.
			expect(h.runs.runView("nope")).toBeUndefined();

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
				title: "ask",
				placeholder: JSON.stringify({ questions: [{ id: "q", question: "q?", options: [{ label: "yes" }, { label: "no" }] }] }),
			});
			const res = await pending;
			expect(res.details).toMatchObject({
				status: "needs_input",
				dispatched: true,
				question: "q: q? (yes | no)",
			});
			const { agentId } = res.details as { agentId: string };

			// run NOT finished: the registry returns needs_input with deadline left
			const v1 = h.runs.runView(agentId)!;
			expect(v1.state).toBe("waiting_input");
			expect(v1.deadlineMsLeft).toBeGreaterThan(0);
			// structured request survives to the registry (lossless forwarding)
			expect(v1.request?.questions[0]?.id).toBe("q");
			expect(v1.question).toBeDefined();
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
			const { agentId } = res.details as { agentId: string };
			expect(h.runtime.inspect(agentId)[0]!.alive).toBe(true); // NOT cancelled

			// F3: with no blocking waiter left, a new ask must reach
			// Main as a workspace notification (not vanish).
			proc.writeToStdout({
				type: "extension_ui_request",
				id: "ui-detach",
				method: "input",
				title: "ask",
				placeholder: JSON.stringify({ questions: [{ id: "q2", question: "Second question while detached?", options: [{ label: "a" }] }] }),
			});
			await tick(30);
			const ask = h.messages.find(
				(m) => m.message.customType === "subagent-event" && String(m.message.content).includes("[subagent needs input]"),
			);
			expect(ask).toBeDefined();
			expect(String(ask!.message.content)).toContain("Second question while detached?");

			// F3: after respond, input_resolved clears the pending question —
			// the registry must stop claiming an answer is still expected.
			await h.runtime.respond(agentId, "answer");
			await tick(20);
			expect(h.runs.runView(agentId)!.state).not.toBe("waiting_input");

			// the run finishes on its own
			writeEnvelope(h, agentId);
			settleRun(proc, "finished while detached");
			await tick(80);
			const done = h.messages.find(
				(m) => m.message.customType === "subagent-event" && String(m.message.content).includes("[subagent completed]"),
			);
			expect(done).toBeDefined(); // completion notification still arrives
			expect(h.runs.runView(agentId)!.terminal).toMatchObject({ status: "done" });
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

describe("N1 profile order and sequential report", () => {
	test("reporting bridge loads BEFORE task-workspace; the readiness probe is the last (observer) entry", () => {
		const entries = defaultProfileEntries("/ext");
		expect(entries).toHaveLength(3);
		expect(entries[0]).toContain("reporting-bridge.ts");
		expect(entries[1]).toContain(path.join("task-workspace", "index.ts"));
		// The probe is a subagents-owned file and comes last: its session_start
		// observer must not perturb the capability entries' tool_call order.
		expect(entries[2]).toContain("readiness-probe.ts");
	});
});

describe("N2 deadline vs retire race", () => {
	test("deadline firing during retire cannot turn a decided done into cancel/partial", async () => {
		// killGraceMs 900 makes retire() hang ~0.9s (fake ignores SIGTERM);
		// the deadline (1500ms after registration) lands inside that window.
		const h = makeLayer({ killGraceMs: 900 });
		try {
			const ws = makeWorktree(h.taskRoot, "race-ws");
			const pending = dispatchCall(h, { workspace: ws, task: "t", timeout_ms: 1500 });
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			const proc = h.lastProc();
			proc.ignoreSigterm = true;
			confirmReadiness(proc, "task-workspace", {
				tools: ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"],
			});
			confirmReadiness(proc, "workspace-reporting", { tools: ["report_result"] });
			autoAcceptPrompt(proc);
			await tick(30);
			const agentId = h.agentId();

			// settle with a fresh envelope shortly BEFORE the deadline; retire
			// then crosses it.
			await tick(700);
			writeEnvelope(h, agentId, { generation: 1 });
			settleRun(proc, "settled in time");

			const res = await pending;
			expect(res.details).toMatchObject({
				status: "done",
				reason: undefined,
				child_may_have_mutated_repo: false,
			});
			// the runtime record must agree with the workspace outcome: the
			// controller keeps `completed` (retire won the exit, cancel never
			// claimed it).
			expect(h.runtime.inspect(agentId)[0]!.state).toBe("completed");
			// exactly one completion notification, no partial/cancel noise
			const completions = h.messages.filter(
				(m) => m.message.customType === "subagent-event" && String(m.message.content).includes("status: done"),
			);
			expect(completions.length).toBe(1);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});
});

describe("N3 pre-dispatch abort", () => {
	test("abort before execute → blocked, dispatched:false, no process", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "abort0-ws");
			const ac = new AbortController();
			ac.abort();
			const res = await dispatchCall(h, { workspace: ws, task: "t" }, ac.signal);
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain("aborted before dispatch");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("abort during readiness → child killed, task never sent, blocked dispatched:false", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "abort-ws");
			const ac = new AbortController();
			const pending = dispatchCall(h, { workspace: ws, task: "t" }, ac.signal);
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			const proc = h.lastProc();
			ac.abort(); // BEFORE any readiness confirmation: prompt not sent yet
			const res = await pending;
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain("aborted before dispatch");
			expect(proc.commands.find((c) => c.type === "prompt" && c.id === "spawn-prompt")).toBeUndefined();
			expect(proc.signalsReceived).toContain("SIGKILL");
		} finally {
			h.cleanup();
		}
	});
});

	describe("run registry and allow-list", () => {
	test("unknown agent id has no run view; policy matrix matches the contract", async () => {
		const h = makeLayer();
		try {
			expect(h.runs.runView("sa-nope")).toBeUndefined();
			expect(h.runs.isManaged("sa-nope")).toBe(false);

			expect(managedAgentOpPolicy("status").allowed).toBe(true);
			expect(managedAgentOpPolicy("result").allowed).toBe(true);
			expect(managedAgentOpPolicy("respond").allowed).toBe(true);
			expect(managedAgentOpPolicy("cancel").allowed).toBe(true);
			expect(managedAgentOpPolicy("wait").allowed).toBe(false);
			expect(String(managedAgentOpPolicy("wait").reason)).toContain("op=status / op=result");
			expect(managedAgentOpPolicy("steer").allowed).toBe(false);
			expect(managedAgentOpPolicy("follow_up").allowed).toBe(false);
			expect(managedAgentOpPolicy("spawn").allowed).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});
