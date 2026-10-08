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
import type { ModelLike } from "../model-classes/core";
import { LocalSubagentRuntime } from "./controller";
import {
	autoAcceptPrompt,
	confirmReadiness,
	createFakeSpawnFactory,
	type FakeRpcProcess,
	settleRun,
} from "./fake-rpc";
import { envelopeFileName, type Envelope } from "./envelope";
import { saveProgress } from "./progress";
import { loadResult } from "./result-store";
import { agentDetailView } from "./index";
import { handleInspectionRequest } from "../inspection-channel";
import { inspectionRegistry, setSubagentInspectionSource } from "./inspection-seam";
import { resetOwnDeliveryMark, setOwnDeliveryWindowMs } from "./steering-wake";
import { attachDelivery } from "./wiring";
import {
	createWorkspaceRuns,
	defaultProfileEntries,
	managedAgentOpPolicy,
	type WorkspaceRuns,
	type GitState,
} from "./workspace-runs";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

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

interface Harness {
	runtime: LocalSubagentRuntime;
	harness: ReturnType<typeof createFakeSpawnFactory>;
	runs: WorkspaceRuns;
	tmp: string;
	taskRoot: string;
	messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	pi: ExtensionAPI;
	cleanup(): void;
	agentId(): string;
	lastProc(): FakeRpcProcess;
}

function makeLayer(layerOpts?: {
	profileEntries?: () => string[];
	killGraceMs?: number;
	steeringWakePollMs?: number;
	readGitState?: (workspace: string) => Promise<GitState>;
}): Harness {
	const harness = createFakeSpawnFactory();
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "wsagent-test-"));
	const tmp = path.join(base, "results");
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(tmp, { recursive: true });
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const taskRoot = fs.realpathSync(taskRootRaw);
	// Pin the task root for the layer under test: AGENT_TASK_ROOT is set
	// to the fixture, proving the override feeds the layer (and that an
	// ambient value cannot leak). Restored in cleanup(). The model-classes
	// storage is pinned the same way: routed-pair resolution must never
	// depend on (or accidentally read) the real user's agent dir.
	const previousGeneric = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = taskRoot;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(base, "agent-dir");
	fs.mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

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
		webSearchPath: "/fake/web-search.ts",
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
		pi,
		cleanup() {
			if (previousGeneric === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousGeneric;
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

function dispatchCall(
	h: Harness,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	ctxOverride?: unknown,
	hasPendingMessages?: () => boolean,
) {
	const ctx = (ctxOverride ?? CTX) as {
		model?: { provider: string; id: string };
		thinkingLevel?: string;
		cwd?: string;
		modelRegistry?: { getAll(): ModelLike[] };
	};
	return h.runs.spawnRun({
		workspace: params.workspace as string,
		task: params.task as string,
		deadlineSec: params.timeout_ms !== undefined ? (params.timeout_ms as number) / 1000 : undefined,
		waitTimeoutSec: params.waitTimeoutSec as number | undefined,
		signal,
		hasPendingMessages,
		modelClass: params.modelClass as string | undefined,
		sessionModel: ctx.model,
		modelRegistry: ctx.modelRegistry,
		thinkingLevel: ctx.thinkingLevel,
		cwd: ctx.cwd,
	});
}

/** Drive a dispatch to a running child: confirm readiness, accept the prompt. */
async function driveToRunning(
	h: Harness,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	ctxOverride?: unknown,
	hasPendingMessages?: () => boolean,
) {
	const pending = dispatchCall(h, params, signal, ctxOverride, hasPendingMessages);
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
	confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
	autoAcceptPrompt(proc);
	await tick(20);
	return { pending, proc };
}

function writeEnvelope(
	h: Harness,
	agentId: string,
	opts?: {
		stale?: boolean;
		status?: Envelope["status"];
		generation?: number;
		summary?: string;
		changed_scope?: string[];
		verification?: Envelope["verification"];
		gaps?: string[];
		contractConflicts?: string[];
	},
): void {
	const envelope: Envelope = {
		status: opts?.status ?? "done",
		summary: opts?.summary ?? "all good",
		changed_scope: opts?.changed_scope ?? ["f.md"],
		verification: opts?.verification ?? [{ check: "bun test", result: "pass" }],
		gaps: opts?.gaps ?? [],
		...(opts?.contractConflicts ? { contract_conflicts: opts.contractConflicts } : {}),
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

describe("RepoOwner dispatch budget", () => {
	test.each([
		{ timeoutMs: 600000, reserveSeconds: 120, finalizationStartsAt: 480 },
		{ timeoutMs: 100000, reserveSeconds: 30, finalizationStartsAt: 70 },
		{ timeoutMs: 1000, reserveSeconds: 1, finalizationStartsAt: 0 },
	])(
		"augments only the initial child prompt for a $timeoutMs ms deadline",
		async ({ timeoutMs, reserveSeconds, finalizationStartsAt }) => {
			const h = makeLayer();
			try {
				const ws = makeWorktree(h.taskRoot, `budget-${timeoutMs}-ws`);
				const task = "Implement the requested slice.";
				const { proc } = await driveToRunning(h, { workspace: ws, task, timeout_ms: timeoutMs });
				const prompt = proc.commands.find((c) => c.type === "prompt" && c.id === "spawn-prompt");

				expect(prompt?.message).toBe(
					`${task}\n\n` +
						`Runtime budget (enforced):\n` +
						`- Hard deadline: ${timeoutMs / 1000} seconds.\n` +
						`- Finalization reserve: ${reserveSeconds} seconds (starts ${finalizationStartsAt} seconds after dispatch).\n` +
						`At the reserve boundary, stop starting new scope, commit coherent work, run only checks that fit, and call report_result with status partial rather than letting the deadline kill a mid-change worktree.`,
				);
				expect(h.runtime.inspect(h.agentId())[0]!.task).toBe(task);
			} finally {
				await h.runtime.shutdown();
				h.cleanup();
			}
		},
	);
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
			// terminal notification was sent once, in the compact event shape
			expect(h.messages).toHaveLength(1);
			const note = String(h.messages[0]!.message.content);
			expect(note).toContain("[subagent completed]");
			expect(note).toContain("summary: all good");
			expect(note).toContain("✓ 1/1 checks · scope: f.md");
			expect(note).toContain(`details via subagent op=result id=${agentId}`);
			// no raw envelope JSON, no duplicate identity/status/git lines
			expect(note).not.toContain("\"summary\"");
			expect(note).not.toContain("agentId: ");
			expect(note).not.toContain("status: done");
			expect(note).not.toContain("git: ");
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

describe("completion event shape", () => {
	test("envelope JSON never appears in the event; summary + metrics + pointer do", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "compact-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work it" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId, {
				summary: "s".repeat(500), // the summary IS the report: kept whole
				changed_scope: ["a.md", "b.md", "c.md", "d.md"], // > 2 → collapsed
				verification: [
					{ check: "one", result: "pass" },
					{ check: "two", result: "pass" },
				],
			});
			settleRun(proc, "did the work");
			await pending;

			expect(h.messages).toHaveLength(1);
			const note = String(h.messages[0]!.message.content);
			// summary delivered verbatim, never truncated into a JSON dump
			expect(note).toContain(`summary: ${"s".repeat(500)}`);
			expect(note).not.toContain(JSON.stringify({ status: "done" }));
			expect(note).not.toContain("\"changed_scope\"");
			// counts + collapsed scope names, mirroring the render.ts card
			expect(note).toContain("✓ 2/2 checks · scope: a.md, b.md +2 more");
			expect(note).toContain(`details via subagent op=result id=${agentId}`);
			// identity/status/git live only in the folded lines
			expect(note).not.toContain("agentId: ");
			expect(note).not.toContain("git: ");
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("blocked without envelope: reason + flag only, no summary/metrics lines", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "noenv-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t", timeout_ms: 600000 });
			// exhaust the report ladder → blocked, no envelope at all
			for (let i = 0; i < 4; i++) {
				await settleRun(proc, `s${i}`);
				await tick(80);
			}
			const res = await pending;
			expect(res.details).toMatchObject({ status: "blocked", reason: "no_valid_report" });

			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			expect(note).toBeDefined();
			const text = String(note!.message.content);
			expect(text).toMatch(/blocked · feat\/noenv-ws @ [0-9a-f]{7} · clean/);
			expect(text).toContain("reason: no_valid_report");
			expect(text).toContain("child_may_have_mutated_repo: true");
			expect(text).not.toContain("summary:");
			expect(text).not.toMatch(/[✓✗] \d+\/\d+ checks/);
			expect(text).not.toContain("gaps:");
			expect(text).toContain(`details via subagent op=result id=`);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("gaps and contract conflicts render as their own lines; partial glyph on a failed check", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "gaps-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const agentId = h.agentId();
			writeEnvelope(h, agentId, {
				status: "partial",
				summary: "mostly there",
				changed_scope: ["x.md", "y.md"], // ≤ 2 → joined without a tail
				verification: [
					{ check: "ok check", result: "pass" },
					{ check: "bad check", result: "fail" },
				],
				gaps: ["cleanup pending", "docs not updated"],
				contractConflicts: ["branch policy vs task", "hook policy vs spec"],
			});
			settleRun(proc, "reported partial");
			await pending;

			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			const text = String(note!.message.content);
			expect(text).toContain("summary: mostly there");
			expect(text).toContain("✗ 1/2 checks · scope: x.md, y.md");
			expect(text).toContain("gaps: cleanup pending; docs not updated");
			expect(text).toContain("contract conflicts: branch policy vs task; hook policy vs spec");
			expect(text).toContain(`details via subagent op=result id=${agentId}`);
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
			// the completion notification folds the objective facts into the
			// status line
			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			const sha = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			expect(String(note?.message.content)).toContain(`done · feat/a3-clean-ws @ ${sha.slice(0, 7)} · clean`);
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
			// unreadable git → no facts → the event carries a plain status line
			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			expect(String(note?.message.content)).toContain("\nblocked\n");
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
			// Delivery status is done, but the compact event must surface the
			// partial product instead of advertising a plain "done".
			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			expect(String(note?.message.content)).toContain("done (report: partial) · feat/a3-partial-ws @");
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
			// Same masking for a blocked product delivered over a done settle.
			const note = h.messages.find((m) => String(m.message.content).includes("[subagent completed]"));
			expect(String(note?.message.content)).toContain("done (report: blocked) · feat/a3-blockedenv-ws @");
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
			const note = String(h.messages[0]!.message.content);
			expect(note).toMatch(/partial · feat\/deadline-ws @ [0-9a-f]{7} · clean/);
			expect(note).toContain("reason: deadline");
			expect(note).not.toContain("summary:");
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
			confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
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
			confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
			autoAcceptPrompt(proc);
			await tick(20);

			ac.abort(); // main abort AFTER dispatch — detach, not cancel
			const res = await pending;
			expect(res.details).toMatchObject({ dispatched: true, state: "running" });
			expect(String(res.details.reason)).toContain("detached by main abort");
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
			const done = await waitForMessage(
				h.messages,
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

describe("steering wake (pending-message detach)", () => {
	test("pending user message detaches the blocking dispatch: steering-wake reason; child survives; completion still delivered", async () => {
		const h = makeLayer({ steeringWakePollMs: 15 });
		try {
			// cold marker: a previous test's own deliveries must not suppress
			// this wake
			resetOwnDeliveryMark();
			const ws = makeWorktree(h.taskRoot, "wake-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" }, undefined, undefined, () => true);
			const agentId = h.agentId();

			const res = await pending;
			expect(res.details).toMatchObject({ status: "running", dispatched: true, state: "running" });
			const reason = String(res.details.reason);
			expect(reason).toContain("user sent a message");
			expect(reason).toContain("op=cancel");
			// the detach is NOT a cancel: the child keeps running
			expect(h.runtime.inspect(agentId)![0]!.alive).toBe(true);
			expect(proc.closed).toBe(false);
			// detached: no completion delivery yet
			expect(h.messages).toHaveLength(0);

			// the run still settles on its own and delivers the background completion
			writeEnvelope(h, agentId);
			settleRun(proc, "finished after the wake");
			const done = await waitForMessage(
				h.messages,
				(m) => m.message.customType === "subagent-event" && String(m.message.content).includes("[subagent completed]"),
			);
			expect(done).toBeDefined();
			expect(h.runs.runView(agentId)!.terminal).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 10000);

	test("own delivery (generic child completing during the wait) does not detach the workspace wait", async () => {
		setOwnDeliveryWindowMs(150); // keep the suppression window short for the test
		const h = makeLayer({ steeringWakePollMs: 15 });
		try {
			// production delivery path: generic child events enqueue own
			// [subagent ...] messages (and mark the suppression window)
			attachDelivery(h.pi, h.runtime);
			resetOwnDeliveryMark();
			const ws = makeWorktree(h.taskRoot, "own-wake-ws");
			let pendingUser = false;
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" }, undefined, undefined, () => pendingUser);
			const agentId = h.agentId();

			// a generic (non-workspace) child completes in the background:
			// wiring enqueues its own delivery, opening the suppression window
			const genericPending = h.runtime.spawn({ task: "background child", cwd: h.tmp });
			// the spawn resolves only after the prompt is accepted: arm the
			// auto-accept as soon as the process exists
			for (let i = 0; i < 100 && h.harness.spawned.length < 2; i++) await tick(20);
			const genericProc = h.harness.spawned[h.harness.spawned.length - 1]!;
			autoAcceptPrompt(genericProc);
			const generic = (await genericPending).id;
			await tick(20);
			settleRun(genericProc, "generic done");
			const note = await waitForMessage(
				h.messages,
				(m) => (m.message.details as { agentId?: string; kind?: string } | undefined)?.agentId === generic &&
					(m.message.details as { kind?: string } | undefined)?.kind === "completed",
			);
			expect(note).toBeDefined(); // own delivery enqueued

			// worst case for the wake: pending messages are reported NOW (as a
			// pi build that counts own deliveries would). Within the window the
			// own delivery must NOT detach the workspace wait.
			pendingUser = true;
			const stillBlocked = await Promise.race([
				pending.then(() => "woke" as const),
				tick(60).then(() => "blocked" as const),
			]);
			expect(stillBlocked).toBe("blocked");

			// window open or not, once the pending check clears the wait stays
			// healthy and settles normally on the workspace child's completion
			pendingUser = false;
			writeEnvelope(h, agentId);
			settleRun(proc, "workspace done");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done" });
		} finally {
			setOwnDeliveryWindowMs(2000);
			resetOwnDeliveryMark();
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 10000);
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

describe("provider propagation fail-fast (R2)", () => {
	test("needed-but-missing provider \u2192 blocked, dispatched:false, no process", async () => {
		const h = makeLayer();
		// Rebind the layer's runtime resolution: construct an isolated layer
		// whose runtime fails spawn with the provider error (as index.ts wires
		// it when no installed package provides the child model's provider).
		const { LocalSubagentRuntime: RT } = await import("./controller");
		const { ProviderExtensionError } = await import("./provider-extensions");
		const runtime2 = new RT({
			defaultCwd: h.tmp,
			resultsDir: h.tmp,
			piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
			bridgePath: "/fake/bridge.ts",
			webSearchPath: "/fake/web-search.ts",
			spawnFn: h.harness.spawnFn,
			startTimeoutMs: 2000,
			readinessTimeoutMs: 5000,
			providerResolution: () => {
				throw new ProviderExtensionError(
					'cannot spawn child for model "cloudru/Qwen/Qwen3.5": provider "cloudru" is registered by an extension in this session, but no configured, installed package provides its extension entries. Install the provider package (pi install <package-source>) or pick a model from a builtin provider.',
				);
			},
		});
		const runs2 = createWorkspaceRuns(h.pi, () => runtime2);
		try {
			const ws = makeWorktree(h.taskRoot, "r2-provider-ws");
			const res = await runs2.spawnRun({
				workspace: ws,
				task: "t",
				sessionModel: { provider: "cloudru", id: "Qwen/Qwen3.5" },
			});
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain("pi install <package-source>");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	}, 20000);
});

describe("spawn-mode routing (R3)", () => {
	/** Registry with two distinct models so routed vs session pairs differ. */
	const ROUTED_REGISTRY: ModelLike[] = [
		{ provider: "zai", id: "glm-x", reasoning: true },
		{ provider: "zai", id: "glm-max", reasoning: true, thinkingLevelMap: { xhigh: "xh", max: "mx" } },
	];
	const ROUTED_CTX = {
		model: { provider: "zai", id: "glm-x" }, // session runs the light model
		thinkingLevel: "low",
		cwd: "/tmp",
		modelRegistry: { getAll: () => ROUTED_REGISTRY },
	};

	/** Write routing storage into the harness's pinned agent dir. */
	function seedAgentStorage(h: Harness, stored: Record<string, unknown>): void {
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR!, "model-classes.json"),
			JSON.stringify(stored),
		);
	}

	test("route repoOwner heavy: session on the light model, owner dispatched with the heavy pair (A3)", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, {
				heavy: { model: "zai/glm-max", thinking: "xhigh" },
				routing: { repoOwner: "heavy" },
			});
			const ws = makeWorktree(h.taskRoot, "routed-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "own it" }, undefined, ROUTED_CTX);
			const args = proc.spec.args;
			expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-max");
			expect(args[args.indexOf("--thinking") + 1]).toBe("xhigh");
			// the run semantics are unchanged: fresh envelope settles done
			const agentId = h.agentId();
			writeEnvelope(h, agentId);
			settleRun(proc, "owned it");
			const res = await pending;
			expect(res.details).toMatchObject({ status: "done", dispatched: true, agentId });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 20000);

	test("no routing, no saved heavy: owner falls to the session pair (migration, A1)", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, { deep: { model: "zai/glm-max", thinking: "xhigh" } });
			const ws = makeWorktree(h.taskRoot, "inherit-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "t" }, undefined, ROUTED_CTX);
			const args = proc.spec.args;
			expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-x");
			expect(args[args.indexOf("--thinking") + 1]).toBe("low");
			writeEnvelope(h, h.agentId());
			settleRun(proc, "done");
			expect((await pending).details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 20000);

	test("no routing, saved heavy: owner runs the implicit heavy pair, not the session pair", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, { heavy: { model: "zai/glm-max", thinking: "xhigh" } });
			const ws = makeWorktree(h.taskRoot, "implicit-heavy-ws");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "own it" }, undefined, ROUTED_CTX);
			const args = proc.spec.args;
			expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-max");
			expect(args[args.indexOf("--thinking") + 1]).toBe("xhigh");
			writeEnvelope(h, h.agentId());
			settleRun(proc, "done");
			expect((await pending).details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 20000);

	test("explicit modelClass overrides repoOwner routing (A4)", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, {
				smart: { model: "zai/glm-max", thinking: "max" },
				heavy: { model: "zai/glm-max", thinking: "xhigh" },
				routing: { repoOwner: "smart" },
			});
			// routing points at smart/max, the explicit class asks for xhigh
			const ws = makeWorktree(h.taskRoot, "override-ws");
			const { pending, proc } = await driveToRunning(
				h,
				{ workspace: ws, task: "t", modelClass: "heavy" },
				undefined,
				ROUTED_CTX,
			);
			const args = proc.spec.args;
			expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-max");
			expect(args[args.indexOf("--thinking") + 1]).toBe("xhigh"); // heavy, not the routed smart/max
			writeEnvelope(h, h.agentId());
			settleRun(proc, "done");
			expect((await pending).details).toMatchObject({ status: "done" });
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	}, 20000);

	test("broken routing (class not saved) → blocked, dispatched:false, no process, fix named (A6)", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, { routing: { repoOwner: "nosuch" } });
			const ws = makeWorktree(h.taskRoot, "brokenroute-ws");
			const res = await dispatchCall(h, { workspace: ws, task: "t" }, undefined, ROUTED_CTX);
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			const reason = String(res.details.reason);
			expect(reason).toContain('"repoOwner"');
			expect(reason).toContain('"nosuch"');
			expect(reason).toContain("/model-class route repoOwner <class|inherit>");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("hand-edited invalid routing target (\"default\") → blocked with the routing fix, never silent inheritance (A6)", async () => {
		const h = makeLayer();
		try {
			// "default" is a reserved word, not a saved class: it must fail as a
			// routing error — not be reinterpreted as the session pair.
			seedAgentStorage(h, { heavy: { model: "zai/glm-max", thinking: "xhigh" }, routing: { repoOwner: "default" } });
			const ws = makeWorktree(h.taskRoot, "invalidroute-ws");
			const res = await dispatchCall(h, { workspace: ws, task: "t" }, undefined, ROUTED_CTX);
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			const reason = String(res.details.reason);
			expect(reason).toContain('set to class "default"');
			expect(reason).toContain('"repoOwner"');
			expect(reason).toContain("/model-class route repoOwner <class|inherit>");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("routed dead model → blocked with the re-save fix (A7)", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, { heavy: { model: "gone/vanished", thinking: "high" }, routing: { repoOwner: "heavy" } });
			const ws = makeWorktree(h.taskRoot, "deadmodel-ws");
			const res = await dispatchCall(h, { workspace: ws, task: "t" }, undefined, ROUTED_CTX);
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			const reason = String(res.details.reason);
			expect(reason).toContain("no longer available");
			expect(reason).toContain("/model-class heavy set");
			expect(h.harness.spawned).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	test("explicit unknown modelClass on a workspace spawn → blocked with the saved names listed", async () => {
		const h = makeLayer();
		try {
			seedAgentStorage(h, { heavy: { model: "zai/glm-max", thinking: "xhigh" } });
			const ws = makeWorktree(h.taskRoot, "unknownclass-ws");
			const res = await dispatchCall(
				h,
				{ workspace: ws, task: "t", modelClass: "nosuch" },
				undefined,
				ROUTED_CTX,
			);
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			const reason = String(res.details.reason);
			expect(reason).toContain('"nosuch"');
			expect(reason).toContain("heavy"); // the saved class list
			expect(h.harness.spawned).toHaveLength(0);
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
	test("reporting bridge loads BEFORE task-workspace; subagents index enables nested spawns; the readiness probe is the last (observer) entry", () => {
		const entries = defaultProfileEntries("/ext");
		expect(entries).toHaveLength(4);
		expect(entries[0]).toContain("reporting-bridge.ts");
		expect(entries[1]).toContain(path.join("task-workspace", "index.ts"));
		// The subagents index loads into the workspace child so a RepoOwner
		// can spawn plain `subagent` helpers (modelClass applies to those).
		expect(entries[2]).toBe(path.join("/ext", "index.ts"));
		// The probe is a subagents-owned file and comes last: its session_start
		// observer must not perturb the capability entries' tool_call order.
		expect(entries[3]).toContain("readiness-probe.ts");
	});

	test("the workspace child profile carries the subagents extension (nested spawn capability)", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "nested-profile-ws");
			const { proc } = await driveToRunning(h, { workspace: ws, task: "t" });
			const args = proc.spec.args;
			const exts = args.map((a, i) => (a === "-e" ? args[i + 1] : null)).filter(Boolean);
			// base bridge + RepoOwner profile; the subagents index is loaded
			// into THIS child, so op=spawn is available inside the owner.
			expect(exts.some((e) => e.endsWith("/subagents/index.ts"))).toBe(true);
			expect(exts.some((e) => e.endsWith("reporting-bridge.ts"))).toBe(true);
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
	});

	test("a tool-set report without the nested `subagent` tool fails closed", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "nested-missing-ws");
			const pending = h.runs.spawnRun({
				workspace: ws,
				task: "t",
				sessionModel: { provider: "zai", id: "glm-x" },
				thinkingLevel: "low",
				cwd: h.tmp,
			});
			for (let i = 0; i < 100 && h.harness.spawned.length === 0; i++) await tick(20);
			const proc = h.lastProc();
			// everything EXCEPT the nested subagent tool: the subagents entry
			// is unsatisfied → the task must never reach this child's model.
			confirmReadiness(proc, {
				tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "task"],
			});
			// spawnRun surfaces the readiness failure as an unsupported result
			// (dispatched:false) — the classification of a broken profile.
			const res = await pending;
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(String(res.details.reason)).toContain("missing required tools");
			expect(String(res.details.reason)).toContain("subagent");
			expect(proc.signalsReceived).toContain("SIGKILL");
			expect(proc.commands.find((c) => c.type === "prompt" && c.id === "spawn-prompt")).toBeUndefined();
		} finally {
			await h.runtime.shutdown();
			h.cleanup();
		}
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
			confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
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
				(m) => m.message.customType === "subagent-event" && String(m.message.content).includes("done · feat/race-ws"),
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
			expect(managedAgentOpPolicy("wait").allowed).toBe(true);
			expect(managedAgentOpPolicy("steer").allowed).toBe(true);
			expect(managedAgentOpPolicy("follow_up").allowed).toBe(false);
			expect(managedAgentOpPolicy("spawn").allowed).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

const reportedProgress = { achieved: "tests pass", currentWork: "checking races", blocker: "agent claim", nextStep: "commit" };
const testFacts = { branch: "feat/test", headSha: "abcdef", dirty: { staged: [], unstaged: [] } };

function askNow(proc: FakeRpcProcess) {
	proc.writeToStdout({ type: "extension_ui_request", id: "question", method: "input", title: "ask",
		placeholder: JSON.stringify({ questions: [{ id: "q", question: "Which?", options: [{ label: "yes" }] }] }) });
}

describe("ZAVOD-39 continuous wait and progress", () => {
	test("timeout and repeated wait retain same child, deadline, ownership and later notification", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "wait-progress");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.05, timeout_ms: 10000 });
			const id = h.agentId();
			const deadline = h.runs.runView(id)!.deadlineAt;
			const first = saveProgress(id, reportedProgress, h.tmp);
			const previous = inspectionRegistry.subagents;
			setSubagentInspectionSource({ inspect: () => h.runtime.inspect(), view: (s) => agentDetailView(s, h.runs.runView(s.id)) });
			try {
				const read = await handleInspectionRequest('{"v":1,"id":"live","op":"snapshot","area":"subagents"}', { cwd: ws }) as any;
				expect(read.result.data.agents[0].run).toMatchObject({ progress: first, deadlineAt: deadline });
				expect(read.result.data.agents[0].run).not.toHaveProperty("git_facts");
			} finally { inspectionRegistry.subagents = previous; }
			const released = await pending;
			expect(released.details).toMatchObject({ status: "running", agentId: id, deadlineAt: deadline, progress: first });
			expect(String(released.details.reason)).toContain("wait_timeout");
			expect(proc.closed).toBe(false);
			expect((await dispatchCall(h, { workspace: ws, task: "duplicate" })).details).toMatchObject({ status: "blocked", dispatched: false });
			const second = saveProgress(id, { achieved: "second result", currentWork: "verification", nextStep: "report" }, h.tmp);
			const repeated = await h.runs.waitRun(id, { timeoutSec: 0.01 });
			expect(repeated.details).toMatchObject({ status: "running", agentId: id, deadlineAt: deadline, progress: second });
			expect(h.runs.runView(id)!.progress?.blocker).toBeUndefined();
			writeEnvelope(h, id);
			settleRun(proc, "done");
			expect(await waitForMessage(h.messages, (m) => String(m.message.content).includes("[subagent completed]"))).toBeDefined();
			const terminal = await h.runs.waitRun(id, { timeoutSec: 0.01 });
			expect(terminal.details).toMatchObject({ status: "done", progress: second, git_facts: { branch: "feat/wait-progress" } });
			expect(h.harness.spawned).toHaveLength(1);
			expect(loadResult(id, h.tmp)?.run).toMatchObject({ state: "settled", deadlineAt: deadline, progress: second, terminal: { status: "done" } });
			expect(loadResult(id, h.tmp)?.run).not.toHaveProperty("progressAgeMs");
			const restored = new LocalSubagentRuntime({ defaultCwd: h.tmp, resultsDir: h.tmp, piCommand: { command: "node", args: [] } });
			expect((await restored.result(id))?.run?.progress).toEqual(second);
			expect(restored.inspect()).toEqual([]); // history is not reattached execution
			await restored.shutdown();
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("needs_input beats release, repeated wait observes it, respond resumes the original deadline", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "wait-ask");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.08 });
			const id = h.agentId();
			const deadline = h.runs.runView(id)!.deadlineAt;
			const progress = saveProgress(id, reportedProgress, h.tmp);
			askNow(proc);
			expect((await pending).details).toMatchObject({ status: "needs_input", progress });
			expect((await h.runs.waitRun(id, { timeoutSec: 0.01 })).details).toMatchObject({ status: "needs_input", deadlineAt: deadline });
			await h.runtime.respond(id, "yes");
			expect((await h.runs.waitRun(id, { timeoutSec: 0.01 })).details).toMatchObject({ status: "running", deadlineAt: deadline });
			await h.runs.cancelRun(id);
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("question after wait timeout is notified, and parallel waits/abort do not consume terminal delivery", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "late-question");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.01 });
			await pending;
			const id = h.agentId();
			askNow(proc);
			expect(h.messages.filter((m) => String(m.message.content).includes("[subagent needs input]"))).toHaveLength(1);
			expect((await h.runs.waitRun(id)).details.status).toBe("needs_input");
			await h.runtime.respond(id, "yes");
			const ac = new AbortController();
			const abortedWait = h.runs.waitRun(id, { signal: ac.signal });
			const waiting = h.runs.waitRun(id, { timeoutSec: 1 });
			ac.abort();
			expect((await abortedWait).details.status).toBe("running");
			writeEnvelope(h, id);
			settleRun(proc, "done");
			expect((await waiting).details.status).toBe("done");
			expect(h.messages.filter((m) => String(m.message.content).includes("[subagent completed]"))).toHaveLength(1);
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test.each(["cancel", "deadline"] as const)("%s stops child before facts, preserves progress and returns one terminal", async (cause) => {
		let release!: (state: GitState) => void;
		let reading = false;
		const factsGate = new Promise<GitState>((r) => { release = r; });
		const h = makeLayer({ killGraceMs: 30, readGitState: async () => {
			expect(h.lastProc().closed).toBe(true);
			reading = true;
			return factsGate;
		} });
		try {
			const ws = makeWorktree(h.taskRoot, `facts-${cause}`);
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.01, timeout_ms: cause === "deadline" ? 1000 : 10000 });
			const id = h.agentId();
			const progress = saveProgress(id, reportedProgress, h.tmp);
			await pending;
			proc.ignoreSigterm = true;
			const cancellation = cause === "cancel" ? h.runs.cancelRun(id) : undefined;
			for (let i = 0; !reading && i < 200; i++) await tick(10);
			expect(reading).toBe(true);
			const view = h.runs.runView(id)!;
			expect(view.terminal).toBeUndefined();
			expect(view.state).toBe("terminating");
			expect(view.progress).toEqual(progress);
			expect((await h.runs.waitRun(id, { timeoutSec: 0.01 })).details).toMatchObject({ status: "running" });
			expect((await dispatchCall(h, { workspace: ws, task: "duplicate during facts" })).details).toMatchObject({ status: "blocked", dispatched: false });
			await expect(h.runs.steerRun(id, "explain")).rejects.toThrow("terminating");
			release({ ok: true, facts: testFacts });
			await cancellation;
			const terminal = await h.runs.waitRun(id, { timeoutSec: 1 });
			expect(terminal.details).toMatchObject({ status: cause === "cancel" ? "blocked" : "partial", reason: cause === "cancel" ? "cancelled_by_main" : "deadline", progress, git_facts: testFacts });
			expect(h.messages.filter((m) => String(m.message.content).includes("[subagent completed]"))).toHaveLength(1);
			expect(loadResult(id, h.tmp)?.run?.progress).toEqual(progress);
			const age = h.runs.runView(id)!.progressAgeMs!;
			await tick(5);
			expect(h.runs.runView(id)!.progressAgeMs).toBeGreaterThan(age);
		} finally { release({ ok: true, facts: testFacts }); await h.runtime.shutdown(); h.cleanup(); }
	});
});

describe("ZAVOD-39 ownership races", () => {
	test("concurrent duplicate dispatch (including symlink alias) reserves before readiness", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "two-dispatch");
			const alias = path.join(path.dirname(ws), "alias");
			fs.symlinkSync(ws, alias);
			const ac = new AbortController();
			const calls = [dispatchCall(h, { workspace: ws, task: "a" }, ac.signal), dispatchCall(h, { workspace: alias, task: "b" }, ac.signal)];
			for (let i = 0; h.harness.spawned.length === 0 && i < 100; i++) await tick(10);
			await tick(30);
			expect(h.harness.spawned).toHaveLength(1);
			expect(h.lastProc().commands.some((c) => c.type === "prompt")).toBe(false);
			ac.abort();
			const results = await Promise.all(calls);
			expect(results.every((r) => r.details.dispatched === false)).toBe(true);
			expect(results.some((r) => String(r.details.reason).includes("already has"))).toBe(true);
			expect(h.lastProc().closed).toBe(true);
			// Failed dispatch released only after the child stopped.
			h.harness.onSpawn((proc) => { confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] }); autoAcceptPrompt(proc); });
			const next = await dispatchCall(h, { workspace: ws, task: "retry", waitTimeoutSec: 0.01 });
			expect(next.details).toMatchObject({ status: "running", dispatched: true });
			await h.runs.cancelRun(h.agentId());
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("fresh settlement holds reservation during stop and facts, ignores cancel/deadline races", async () => {
		let release!: (state: GitState) => void;
		let reading = false;
		const gate = new Promise<GitState>((r) => { release = r; });
		const h = makeLayer({ killGraceMs: 60, readGitState: async () => { reading = true; expect(h.lastProc().closed).toBe(true); return gate; } });
		try {
			const ws = makeWorktree(h.taskRoot, "fresh-facts");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.01, timeout_ms: 1000 });
			await pending;
			const id = h.agentId();
			proc.ignoreSigterm = true;
			writeEnvelope(h, id);
			settleRun(proc, "done");
			await tick(20);
			expect(proc.closed).toBe(false);
			expect(h.runs.runView(id)!.terminal).toBeUndefined();
			await expect(h.runs.steerRun(id, "late")).rejects.toThrow();
			for (let i = 0; !reading && i < 100; i++) await tick(10);
			expect(reading).toBe(true);
			const cancel = h.runs.cancelRun(id);
			const wait = h.runs.waitRun(id, { timeoutSec: 2 });
			await tick(1000); // absolute deadline falls DURING Git settlement
			expect(h.runs.runView(id)!.terminal).toBeUndefined();
			expect(h.messages).toHaveLength(0);
			expect((await dispatchCall(h, { workspace: ws, task: "duplicate" })).details.dispatched).toBe(false);
			release({ ok: true, facts: testFacts });
			expect((await wait).details).toMatchObject({ status: "done", git_facts: testFacts });
			await cancel;
			expect(h.messages).toHaveLength(1);
			await expect(h.runtime.followUp(id, "restart")).rejects.toThrow("cannot restart");
		} finally { release({ ok: true, facts: testFacts }); await h.runtime.shutdown(); h.cleanup(); }
	});

	test.each(["before", "after"] as const)("needs_input %s acceptance in the same stdout turn cannot be lost", async (order) => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "immediate-ask");
			h.harness.onSpawn((proc) => {
				confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
				proc.writeToStdout({ type: "agent_start" });
				if (order === "before") askNow(proc);
				proc.writeToStdout({ id: "spawn-prompt", type: "response", command: "prompt", success: true });
				if (order === "after") askNow(proc);
			});
			const result = await dispatchCall(h, { workspace: ws, task: "ask", waitTimeoutSec: 0.03 });
			expect(result.details).toMatchObject({ status: "needs_input", question: "q: Which? (yes)" });
			await h.runs.cancelRun(h.agentId());
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("completion before acceptance is replayed once without resetting the controller terminal record", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "fast-completion");
			h.harness.onSpawn((proc) => {
				confirmReadiness(proc, { tools: ["web_search", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result", "report_progress", "subagent"] });
				proc.writeToStdout({ type: "agent_start" });
				writeEnvelope(h, h.agentId());
				proc.writeToStdout({ type: "agent_settled" });
				proc.writeToStdout({ type: "response", command: "get_last_assistant_text", id: "ctl-last-text", success: true, data: { text: "fast final" } });
				proc.writeToStdout({ id: "spawn-prompt", type: "response", command: "prompt", success: true });
			});
			const result = await dispatchCall(h, { workspace: ws, task: "fast", waitTimeoutSec: 2 });
			expect(result.details.status).toBe("done");
			expect(h.runtime.inspect(h.agentId())[0]!.state).toBe("completed");
			expect(h.lastProc().closed).toBe(true);
			expect(h.messages).toHaveLength(1);
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("steer while bash is active queues without abort/new prompt or changed deadline; settling window rejects", async () => {
		const h = makeLayer();
		try {
			const ws = makeWorktree(h.taskRoot, "safe-steer");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.01 });
			await pending;
			const id = h.agentId();
			const deadline = h.runs.runView(id)!.deadlineAt;
			proc.writeToStdout({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "sleep 90" } });
			await h.runs.steerRun(id, "Explain the delay using report_progress");
			expect(proc.commands.filter((c) => c.type === "prompt")).toHaveLength(1);
			expect(proc.commands.some((c) => c.type === "steer")).toBe(true);
			expect(proc.commands.some((c) => c.type === "abort")).toBe(false);
			expect(proc.signalsReceived).toEqual([]);
			expect(h.runtime.inspect(id)[0]!.activeTool?.name).toBe("bash");
			expect(h.runs.runView(id)!.deadlineAt).toBe(deadline);
			proc.writeToStdout({ type: "agent_settled" }); // controller still says running until last text response
			await expect(h.runs.steerRun(id, "unsafe idle race")).rejects.toThrow("settling");
			await h.runs.cancelRun(id);
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});

	test("broken stdin cannot release ownership before real SIGKILL/close", async () => {
		let reads = 0;
		const h = makeLayer({ killGraceMs: 80, readGitState: async () => {
			expect(h.lastProc().closed).toBe(true);
			reads++;
			return { ok: true, facts: testFacts };
		} });
		try {
			const ws = makeWorktree(h.taskRoot, "epipe-stop");
			const { pending, proc } = await driveToRunning(h, { workspace: ws, task: "work", waitTimeoutSec: 0.01 });
			await pending;
			const id = h.agentId();
			proc.ignoreSigterm = true;
			proc.emitStdinError(new Error("write EPIPE"));
			await tick(10);
			expect(proc.closed).toBe(false);
			expect(reads).toBe(0);
			expect(h.runs.runView(id)!.terminal).toBeUndefined();
			const terminal = await h.runs.waitRun(id, { timeoutSec: 1 });
			expect(terminal.details).toMatchObject({ status: "blocked", reason: "child_failed", git_facts: testFacts });
			expect(proc.signalsReceived).toContain("SIGKILL");
			expect(reads).toBe(1);
			expect(h.messages).toHaveLength(1);
		} finally { await h.runtime.shutdown(); h.cleanup(); }
	});
});
