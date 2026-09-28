/**
 * Unit tests for the `agentkit-status` extension command: registration, the
 * payload contract ({v, area, data}), area handling, the empty-read rule
 * (runtime never instantiated), the wire transport (RPC dialog, finite
 * timeout) vs the non-RPC notify, and the shared agentDetailView() mapping
 * also used by `subagent op=status`. Live wire behavior (get_commands
 * discovery, cancelled answers, real timeout) is covered by
 * live/status-verify.mjs.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension, { agentDetailView } from "./index";
import type { AgentSnapshot } from "./types";
import type { WorkspaceRunView } from "./workspace-runs";

interface CommandDef {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
}

interface CapturedDialog {
	title: string;
	placeholder?: string;
	opts?: { timeout?: number };
}

function makePi() {
	const tools = new Map<string, unknown>();
	const commands = new Map<string, CommandDef>();
	const messages: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: (def: { name: string }) => {
			tools.set(def.name, def);
		},
		registerCommand: (name: string, def: CommandDef) => {
			commands.set(name, def);
		},
		sendMessage: (message: Record<string, unknown>, _options?: unknown) => {
			messages.push(message);
		},
		getThinkingLevel: () => "low",
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, messages };
}

/** Sandbox AGENT_TASK_ROOT so taskStatus reads a throwaway task root. */
function makeEnv() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentkit-status-test-"));
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const previousTaskRoot = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = fs.realpathSync(taskRootRaw);
	return {
		base,
		taskRoot: fs.realpathSync(taskRootRaw),
		restore() {
			if (previousTaskRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousTaskRoot;
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}

function rpcCtx(cwd: string) {
	const dialogs: CapturedDialog[] = [];
	const notified: Array<{ message: string; type?: string }> = [];
	const ctx = {
		mode: "rpc",
		cwd,
		ui: {
			input: (title: string, placeholder?: string, opts?: { timeout?: number }) => {
				dialogs.push({ title, placeholder, opts });
				return Promise.resolve(undefined); // cancelled answer, like the controller's
			},
			notify: (message: string, type?: string) => {
				notified.push({ message, type });
			},
		},
	};
	return { ctx, dialogs, notified };
}

function tuiCtx(cwd: string) {
	const dialogs: CapturedDialog[] = [];
	const notified: Array<{ message: string; type?: string }> = [];
	const ctx = {
		mode: "tui",
		cwd,
		ui: {
			input: (title: string, placeholder?: string, opts?: { timeout?: number }) => {
				dialogs.push({ title, placeholder, opts });
				return Promise.resolve(undefined);
			},
			notify: (message: string, type?: string) => {
				notified.push({ message, type });
			},
		},
	};
	return { ctx, dialogs, notified };
}

function parsePayload(dialog: CapturedDialog | undefined): Record<string, unknown> {
	expect(dialog).toBeDefined();
	expect(dialog!.title).toBe("agentkit:status");
	return JSON.parse(dialog!.placeholder!) as Record<string, unknown>;
}

describe("agentkit-status command registration", () => {
	test("registers agentkit-status with area completions (discovery surface)", () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const def = commands.get("agentkit-status");
		expect(def).toBeDefined();
		expect(def!.description).toContain("model-free");
		const completions = def!.getArgumentCompletions?.("") as Array<{ value: string }>;
		expect(completions.map((c) => c.value)).toEqual(["subagents", "task", "all"]);
		const filtered = def!.getArgumentCompletions?.("ta") as Array<{ value: string }>;
		expect(filtered.map((c) => c.value)).toEqual(["task"]);
	});
});

describe("agentkit-status payload contract", () => {
	test("task area returns structured task state and never triggers a model turn", async () => {
		const { pi, commands, messages } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const { ctx, dialogs } = rpcCtx(env.base);
			await commands.get("agentkit-status")!.handler("task", ctx);
			const payload = parsePayload(dialogs[0]);
			expect(payload).toEqual({
				v: 1,
				area: "task",
				data: {
					task: {
						classification: expect.stringContaining("_"),
					// The task-workspace flow canonicalizes ctx cwd with realpath
					// ("avoid symlink mismatches", e.g. macOS /var -> /private/var),
					// so the payload reports the real path, not the mkdtemp literal.
					cwd: fs.realpathSync(env.base),
						repoRoot: "",
						branch: "",
						isLinkedWorktree: false,
						taskRoot: env.taskRoot,
						taskWorkspaces: [],
					},
				},
			});
			// Model-free read: no delivery messages (the only agent-turn trigger
			// this extension has) and the dialog is the sole effect.
			expect(messages).toEqual([]);
			expect(dialogs).toHaveLength(1);
		} finally {
			env.restore();
		}
	});

	test("subagents area before the first spawn: empty list, runtime not instantiated", async () => {
		const { pi, commands, messages } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const { ctx, dialogs } = rpcCtx(env.base);
			await commands.get("agentkit-status")!.handler("subagents", ctx);
			const payload = parsePayload(dialogs[0]);
			expect(payload).toEqual({ v: 1, area: "subagents", data: { agents: [] } });
			expect(messages).toEqual([]);

			// Behavioral proof that the read did not start the runtime: the
			// /subagents command still reports the never-started state.
			const tui = tuiCtx(env.base);
			await commands.get("subagents")!.handler("", tui.ctx);
			expect(tui.notified[0]!.message).toContain("No subagents: runtime not started yet.");
		} finally {
			env.restore();
		}
	});

	test("default args mean the all area: both agents and task in one payload", async () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const { ctx, dialogs } = rpcCtx(env.base);
			await commands.get("agentkit-status")!.handler("", ctx);
			const payload = parsePayload(dialogs[0]);
			expect(payload.v).toBe(1);
			expect(payload.area).toBe("all");
			expect((payload.data as Record<string, unknown>).agents).toEqual([]);
			expect((payload.data as Record<string, unknown>).task).toMatchObject({ taskRoot: env.taskRoot });
		} finally {
			env.restore();
		}
	});

	test("the RPC dialog carries a finite timeout (fail-closed semantics)", async () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const { ctx, dialogs } = rpcCtx(env.base);
			await commands.get("agentkit-status")!.handler("subagents", ctx);
			expect(dialogs[0]!.opts).toMatchObject({ timeout: 15000 });
		} finally {
			env.restore();
		}
	});

	test("unknown area: error payload over the same dialog path in RPC", async () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const { ctx, dialogs } = rpcCtx(env.base);
			await commands.get("agentkit-status")!.handler("bogus", ctx);
			const payload = parsePayload(dialogs[0]);
			expect(payload).toEqual({ v: 1, area: "bogus", error: "unknown area: bogus (subagents | task | all)" });
		} finally {
			env.restore();
		}
	});

	test("non-RPC mode: brief notify instead of a dialog; unknown area is a brief failure", async () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const read = tuiCtx(env.base);
			await commands.get("agentkit-status")!.handler("", read.ctx);
			expect(read.dialogs).toEqual([]);
			expect(read.notified).toHaveLength(1);
			expect(read.notified[0]!.type).toBe("info");
			expect(read.notified[0]!.message).toContain("/subagents");

			const bad = tuiCtx(env.base);
			await commands.get("agentkit-status")!.handler("nope", bad.ctx);
			expect(bad.dialogs).toEqual([]);
			expect(bad.notified[0]!.type).toBe("error");
			expect(bad.notified[0]!.message).toContain("unknown area: nope");
		} finally {
			env.restore();
		}
	});

	test("a cancelled dialog answer resolves the read cleanly (controller contract)", async () => {
		const { pi, commands } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const dialogs: CapturedDialog[] = [];
			const ctx = {
				mode: "rpc",
				cwd: env.base,
				ui: {
					// Like the real wire: the controller answers {cancelled:true},
					// pi resolves the dialog with undefined.
					input: (title: string, placeholder?: string, opts?: { timeout?: number }) => {
						dialogs.push({ title, placeholder, opts });
						return Promise.resolve(undefined);
					},
					notify: () => {},
				},
			};
			await Promise.race([
				commands.get("agentkit-status")!.handler("all", ctx),
				new Promise((_, reject) => setTimeout(() => reject(new Error("handler hung")), 2000)),
			]);
			expect(dialogs).toHaveLength(1);
		} finally {
			env.restore();
		}
	});
});

describe("agentDetailView (shared with subagent op=status)", () => {
	const snap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
		id: "sa-1",
		label: "worker",
		state: "running",
		task: "x".repeat(300),
		cwd: "/tmp/w",
		alive: true,
		pid: 4242,
		startedAt: 1,
		lastActivityAt: 2,
		elapsedMs: 3,
		...over,
	});

	test("without a run view: the clipped snapshot only", () => {
		const detail = agentDetailView(snap()) as Record<string, unknown>;
		expect(detail.task).toBe(`${"x".repeat(200)}…`);
		expect(detail.run).toBeUndefined();
		expect(detail.pid).toBe(4242);
	});

	test("non-terminal workspace view: compact run view, no terminal status", () => {
		const view: WorkspaceRunView = {
			state: "running",
			workspace: "/tmp/ws",
			deadlineMsLeft: 12345,
			ladder: { step: 1, max: 3 },
		};
		const detail = agentDetailView(snap(), view) as Record<string, unknown>;
		expect(detail.run).toEqual({
			workspace: "/tmp/ws",
			state: "running",
			deadlineMsLeft: 12345,
			ladder: { step: 1, max: 3 },
		});
	});

	test("terminal workspace view: run folds to the terminal status, ladder dropped", () => {
		const view: WorkspaceRunView = {
			state: "completed",
			workspace: "/tmp/ws",
			deadlineMsLeft: 0,
			terminal: { status: "done" } as WorkspaceRunView["terminal"],
		};
		const detail = agentDetailView(snap({ state: "completed", alive: false }), view) as Record<string, unknown>;
		expect(detail.run).toEqual({ workspace: "/tmp/ws", state: "completed", status: "done", deadlineMsLeft: 0 });
	});
});
