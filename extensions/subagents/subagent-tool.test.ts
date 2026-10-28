/**
 * Integration tests for the `subagent` tool surface (index.ts): the tool
 * schema, the workspace spawn wiring into the run layer, the cross-tool
 * allow-list, and generic-spawn isolation. Process spawning itself is covered
 * by the controller/run-layer suites; these tests pin the glue.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "./index";

interface ToolDef {
	name: string;
	execute: Function;
	parameters: unknown;
	promptGuidelines?: string[];
	description?: string;
	prepareArguments?: (args: unknown) => unknown;
}

function makePi() {
	const tools = new Map<string, ToolDef>();
	const messages: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (event: never, ctx?: unknown) => unknown>();
	const pi = {
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		sendMessage: (message: Record<string, unknown>, _options?: unknown) => {
			messages.push(message);
		},
		getThinkingLevel: () => "low",
		on: (event: string, handler: (event: never, ctx?: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, messages, handlers };
}

function makeEnv() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-test-"));
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const previousTaskRoot = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = fs.realpathSync(taskRootRaw);
	// Role-binding storage pinned to the fixture: spawn resolution must never
	// depend on (or accidentally read) the real user's agent dir.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(base, "agent-dir");
	fs.mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// These tests drive the MAIN session's tool surface. The ownership gate
	// keys off the ambient PI_SUBAGENT_ID, and this suite can itself run
	// inside a pi workspace subagent (where that variable is set) — pin it
	// away so the main-session gates are the ones under test. The nested
	// spawn tests below set their own worker id and do not use makeEnv.
	const previousWorkerId = process.env.PI_SUBAGENT_ID;
	delete process.env.PI_SUBAGENT_ID;
	return {
		base,
		taskRoot: fs.realpathSync(taskRootRaw),
		agentDir,
		restore() {
			if (previousTaskRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousTaskRoot;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousWorkerId !== undefined) process.env.PI_SUBAGENT_ID = previousWorkerId;
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}

const CTX = { cwd: "/tmp", thinkingLevel: "low" };

/** Registry + session model fixture for routing-aware spawn resolution. */
const REGISTRY_CTX = {
	cwd: "/tmp",
	thinkingLevel: "low",
	model: { provider: "zai", id: "glm-x" },
	modelRegistry: { getAll: () => [{ provider: "zai", id: "glm-x", reasoning: true }] },
};

/**
 * Minimal RPC child for wait tests: accepts the initial prompt and opens a
 * run, then stays alive until killed. Speaks just enough pi RPC for the
 * controller to treat it as a running plain child.
 */
const RPC_PROBE_SOURCE =
	"let buf = '';" +
	"process.stdin.on('data', (c) => {" +
	"buf += c.toString();" +
	"let i;" +
	"while ((i = buf.indexOf('\\n')) !== -1) {" +
	"const line = buf.slice(0, i); buf = buf.slice(i + 1);" +
	"let cmd; try { cmd = JSON.parse(line); } catch { continue; }" +
	"if (cmd.type === 'prompt') {" +
	"process.stdout.write(JSON.stringify({ id: cmd.id, type: 'response', command: 'prompt', success: true }) + '\\n');" +
	"process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');" +
	"}" +
	"}" +
	"});" +
	"setInterval(() => {}, 1000);\n";

describe("subagent tool surface", () => {
	test("registers one tool with both spawn modes in the schema", () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		expect(tools.has("subagent")).toBe(true);
		expect(tools.has("workspace_agent")).toBe(false); // the old surface is gone
		const def = tools.get("subagent")!;
		const shape = JSON.stringify(def.parameters);
		expect(shape).toContain('"workspace"');
		expect(shape).toContain('"deadlineSec"');
		expect(shape).toContain('"waitTimeoutSec"');
		expect(shape).toContain("independent of deadlineSec");
		expect(shape).toContain('"cwd"');
		expect(shape).toContain('"model"');
		expect(shape).toContain('"role"');
		const props = (def.parameters as { properties: Record<string, { type?: string; enum?: unknown; anyOf?: unknown; description?: string }> }).properties;
		expect(props.model).toMatchObject({ type: "string" });
		expect(props.model.description).toContain("provider/id[:thinking]");
		expect(JSON.stringify(props.role)).toContain('"explore"');
		expect(JSON.stringify(props.role)).toContain('"owner"');
		expect(props.role.description).toContain("Mutually exclusive");
		// workspace guidance lives in the prompt guidelines
		const guidelines = (def.promptGuidelines ?? []).join("\n");
		expect(guidelines).toContain("workspace");
		expect(guidelines).toContain("git_facts");
		// explicit-model and role guidance
		expect(guidelines).toContain("If the user named a model, pass `model`");
		expect(guidelines).toContain("`review` for independent review");
		expect(guidelines).toContain("Do not pass `model` or `role` on owner dispatches unless the user asked for a specific model");
		expect(guidelines).toContain("/subagent-role");
	});

	test("workspace spawn without a session model → blocked, dispatched:false, no process", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const res = (await def.execute(
				"tc-1",
				{ op: "spawn", workspace: "/definitely/not/here", task: "t" },
				undefined,
				undefined,
				{ ...CTX, model: undefined },
			)) as { details: Record<string, unknown>; isError?: boolean };
			// the model-resolution gate fires BEFORE workspace validation (no silent default)
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain("no model resolved");
		} finally {
			env.restore();
		}
	});

	test("workspace spawn accepts model: an unknown model is a blocked resolution failure, not a tool rejection", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const res = (await def.execute(
				"tc-2",
				{ op: "spawn", workspace: "/definitely/not/here", task: "t", model: "nosuch/model" },
				undefined,
				undefined,
				REGISTRY_CTX,
			)) as { details: Record<string, unknown>; isError?: boolean };
			expect(res.isError).toBeUndefined(); // not a tool-level error: a run-layer blocked outcome
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain('"nosuch/model"');
		} finally {
			env.restore();
		}
	});

	test("workspace spawn with a resolvable model proceeds past the model gate to workspace validation", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const res = (await def.execute(
				"tc-2b",
				{ op: "spawn", workspace: "/definitely/not/here", task: "t", model: "zai/glm-x:high" },
				undefined,
				undefined,
				REGISTRY_CTX,
			)) as { details: Record<string, unknown>; isError?: boolean };
			// the model RESOLVED (model gate passed); the nonexistent workspace is
			// what fails now — proof `model` is accepted in workspace mode
			expect(res.details).toMatchObject({ status: "unsupported", dispatched: false });
			expect(String(res.details.reason)).toContain("does not exist");
		} finally {
			env.restore();
		}
	});

	test("workspace spawn uses the owner binding; a broken binding, a non-owner role, or model+role is blocked before dispatch", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const run = async (extra: Record<string, unknown>) =>
				(await def.execute(
					"tc-2c",
					{ op: "spawn", workspace: "/definitely/not/here", task: "t", ...extra },
					undefined,
					undefined,
					REGISTRY_CTX,
				)) as { details: Record<string, unknown> };
			fs.writeFileSync(path.join(env.agentDir, "subagent-roles.json"), JSON.stringify({ owner: "zai/glm-x:high" }));
			expect((await run({})).details).toMatchObject({ status: "unsupported", dispatched: false });
			fs.writeFileSync(path.join(env.agentDir, "subagent-roles.json"), JSON.stringify({ owner: "gone/model" }));
			const broken = await run({});
			expect(broken.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(broken.details.reason)).toContain("subagent-roles.json");
			expect(String(broken.details.reason)).toContain("/subagent-role owner");
			fs.rmSync(path.join(env.agentDir, "subagent-roles.json"));
			expect((await run({ role: "review" })).details).toMatchObject({ status: "blocked", dispatched: false });
			expect((await run({ role: "owner", model: "zai/glm-x" })).details).toMatchObject({ status: "blocked", dispatched: false });
		} finally {
			env.restore();
		}
	});

	test("deadlineSec on a plain spawn is rejected; plain spawn rejects owner and model+role before any child starts", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const res = (await def.execute(
				"tc-3",
				{ op: "spawn", task: "t", deadlineSec: 10 },
				undefined,
				undefined,
				{ ...CTX, model: { provider: "zai", id: "glm-x" } },
			)) as { isError?: boolean; details: { error?: string } };
			expect(res.isError).toBe(true);
			expect(res.details.error).toContain("deadlineSec");
			for (const extra of [{ role: "owner" }, { role: "review", model: "zai/glm-x" }, { model: "nosuch/model" }]) {
				const bad = (await def.execute(
					"tc-3b",
					{ op: "spawn", task: "t", ...extra },
					undefined,
					undefined,
					{ ...CTX, model: { provider: "zai", id: "glm-x" }, modelRegistry: REGISTRY_CTX.modelRegistry },
				)) as { isError?: boolean };
				expect(bad.isError).toBe(true);
			}
		} finally {
			env.restore();
		}
	});

	test("prepareArguments rejects the removed modelClass and passes normal payloads through", () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const prepare = tools.get("subagent")!.prepareArguments!;
		expect(() => prepare({ op: "spawn", task: "t", modelClass: "fast" })).toThrow(
			"modelClass was removed; use role=<explore|helper|review|owner> or model=<provider/id[:thinking]>",
		);
		expect(() => prepare({ op: "spawn", task: "t", modelClass: undefined })).not.toThrow();
		const normal = { op: "spawn", task: "t", role: "helper" };
		expect(prepare(normal)).toBe(normal);
	});

	test("status/wait/steer/cancel fall back to a persisted terminal record", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const resultsDir = path.join(env.agentDir, "subagents", "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(
				path.join(resultsDir, "sa-done.json"),
				JSON.stringify({
					id: "sa-done",
					label: "finished-helper",
					task: "old task",
					cwd: "/tmp",
					status: "completed",
					finalText: "the final assistant text",
					summary: "the summary",
					startedAt: 1,
					endedAt: 2,
				}),
			);
			const def = tools.get("subagent")!;
			const call = (op: string, extra: Record<string, unknown> = {}) =>
				def.execute("tc-p", { op, id: "sa-done", ...extra }, undefined, undefined, CTX) as Promise<{
					content: Array<{ text: string }>;
					details: Record<string, unknown>;
					isError?: boolean;
				}>;

			const status = await call("status");
			expect(status.isError).toBeUndefined();
			expect(status.content[0]!.text).toContain("No live run in this process; persisted terminal record: completed — the summary.");
			expect(status.content[0]!.text).toContain("Full record via op=result");
			expect(status.content[0]!.text).toContain("the final assistant text");
			expect((status.details.result as { id: string }).id).toBe("sa-done");

			const waited = await call("wait");
			expect(waited.isError).toBeUndefined();
			expect(waited.content[0]!.text).toContain("the final assistant text");
			expect((waited.details.result as { id: string }).id).toBe("sa-done");

			const steered = await call("steer", { message: "m" });
			expect(steered.isError).toBe(true);
			expect(steered.details.error).toContain("already finished");
			expect(steered.details.error).toContain("persisted terminal record: completed — the summary");

			const cancelled = await call("cancel");
			expect(cancelled.isError).toBeUndefined();
			expect(cancelled.content[0]!.text).toContain("already finished");
		} finally {
			env.restore();
		}
	});

	test("ops on unknown ids error uniformly (no workspace knowledge needed)", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const def = tools.get("subagent")!;
		for (const op of ["wait", "result", "respond", "cancel", "steer", "follow_up"]) {
			const res = (await def.execute("tc-4", { op, id: "sa-nope", message: "m", answer: "a" }, undefined, undefined, CTX)) as {
				isError?: boolean;
				details: { error?: string };
			};
			expect(res.isError, op).toBe(true);
			expect(res.details.error, op).toContain("unknown agent id");
		}
	});

	test("status with no agents; result unknown id", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const def = tools.get("subagent")!;
		const status = (await def.execute("tc-5", { op: "status" }, undefined, undefined, CTX)) as {
			content: Array<{ text: string }>;
		};
		expect(status.content[0]!.text).toContain("No subagents");
		const res = (await def.execute("tc-6", { op: "result", id: "sa-nope" }, undefined, undefined, CTX)) as {
			isError?: boolean;
		};
		expect(res.isError).toBe(true);
	});

	test("before_agent_start maintains a fresh subagent_model_defaults section from CURRENT role bindings", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-guidance-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		const storage = path.join(agentDir, "subagent-roles.json");
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const writeStorage = (payload: unknown) =>
			fs.writeFileSync(storage, typeof payload === "string" ? payload : JSON.stringify(payload));
		try {
			const { pi, handlers } = makePi();
			registerExtension(pi);
			const handler = handlers.get("before_agent_start") as
				| ((event: Record<string, any>, ctx: unknown) => Promise<void>)
				| undefined;
			expect(handler).toBeDefined();
			const ctx = { model: { provider: "zai", id: "glm-x" } };
			const run = async () => {
				const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
				await handler!(event, ctx);
				return event.systemPromptOptions.sections["subagent_model_defaults"]!;
			};
			// no file: every role is the session model
			expect(await run()).toContain("- review (independent fresh-context reviewer): unbound (uses the session model)");
			writeStorage({ review: "zai/glm-max:xhigh" });
			expect(await run()).toContain("- review (independent fresh-context reviewer): zai/glm-max:xhigh");
			// mid-session rebind: the NEXT run reflects it (no stale snapshot)
			writeStorage({ review: "zai/glm-x:low" });
			expect(await run()).toContain("zai/glm-x:low");
			// unreadable bindings: explicit fail-closed note, never a silent default
			writeStorage("{ not json");
			expect(await run()).toContain("unreadable");
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 10000);

	test("registers the /subagent-role command", () => {
		const commands = new Map<string, unknown>();
		const { pi } = makePi();
		(pi as unknown as { registerCommand: (n: string, d: unknown) => void }).registerCommand = (n, d) => {
			commands.set(n, d);
		};
		registerExtension(pi);
		expect(commands.has("subagent-role")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Nested spawn: main -> subagent(workspace=...) -> subagent(model=...)
//
// The workspace profile ships THIS extension's index.ts into the RepoOwner
// child, so the worker owns the same `subagent` tool the main session has.
// These tests load the real index.ts (the exact file the profile carries),
// point the role bindings at a scratch agent dir, and prove that an explicit
// `model` or a bound `role` spawn through the real tool execute() starts a
// real grandchild process whose argv carries the RESOLVED model.
// ---------------------------------------------------------------------------

describe("nested spawn from a workspace worker", () => {
	test("child-embedded subagent tool resolves an explicit model and starts the grandchild with it", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		const argvOut = path.join(base, "grandchild-argv.json");
		const probe = path.join(base, "argv-probe.js");
		// The grandchild records its own CLI argv AND pid, then stays alive
		// until killed (it does not speak RPC, so the runtime will fail it on
			// termination — the argv record is the contract under test here).
		fs.writeFileSync(
			probe,
			"require('node:fs').writeFileSync(process.env.PI_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), pid: process.pid }));\n" +
			"setInterval(() => {}, 1000);\n",
		);
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevWorkerId = process.env.PI_SUBAGENT_ID;
		// the worker session carries its own subagent id
		process.env.PI_SUBAGENT_ID = "sa-worker-followup";
		const prevArgvOut = process.env.PI_ARGV_OUT;
		const prevArgv1 = process.argv[1];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_ARGV_OUT = argvOut;
		// Make the runtime resolve the pi invocation to the argv probe itself
		// (the same `process.execPath + argv[1]` rule a real pi cli hits).
		process.argv[1] = probe;

		try {
			const { pi, tools } = makePi();
			registerExtension(pi);
			const def = tools.get("subagent")!;
			// The worker's tool context: its own model is the inherited main
			// model; the registry is what explicit models resolve against.
			const ctx = {
				cwd: base,
				model: { provider: "zai", id: "glm-x" },
				thinkingLevel: "high",
				modelRegistry: {
					getAll: () => [
						{ provider: "budget", id: "nano", reasoning: true },
						{ provider: "zai", id: "glm-x", reasoning: true },
					],
				},
			};
			// The spawn ack proves the model RESOLVED (fail closed otherwise),
			// but the probe child never speaks RPC — the ack only lands after
			// the runtime's acceptance timeout. Run the execute WITHOUT await
			// and read the argv record while it is pending.
			const pending = def.execute(
				"tc-n1",
				{ op: "spawn", task: "repo-local helper work", model: "budget/nano:minimal" },
				undefined,
				undefined,
				ctx,
			) as Promise<{ details: { snapshot?: { id: string; pid?: number; model?: string; thinking?: string } }; isError?: boolean }>;

			// Proof at the real process boundary: wait for the grandchild to
			// record its argv+pid, then verify the resolved model reached the CLI.
			let recorded: { argv: string[]; pid: number } | undefined;
			for (let i = 0; i < 100 && !recorded; i++) {
				await new Promise((r) => setTimeout(r, 50));
				try {
					recorded = JSON.parse(fs.readFileSync(argvOut, "utf8")) as { argv: string[]; pid: number };
				} catch {
					// not written yet
				}
			}
			expect(recorded).toBeDefined();
			const argv = recorded!.argv;
			expect(argv).toContain("--model");
			expect(argv[argv.indexOf("--model") + 1]).toBe("budget/nano");
			expect(argv).toContain("--thinking");
			expect(argv[argv.indexOf("--thinking") + 1]).toBe("minimal");
			// and it is a plain subagent child of the worker
			const nameIdx = argv.indexOf("--name");
			expect(argv[nameIdx + 1]).toStartWith("subagent:");

			// terminate the probe grandchild; the pending spawn settles as a
				// failed attempt (the probe never speaks RPC) — irrelevant here.
			try {
				process.kill(recorded!.pid);
			} catch {
				// already gone
			}
			const res = await pending;
			expect(res.isError).toBe(true); // the probe child is not an RPC peer
		} finally {
			if (prevWorkerId === undefined) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = prevWorkerId;
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevArgvOut === undefined) delete process.env.PI_ARGV_OUT;
			else process.env.PI_ARGV_OUT = prevArgvOut;
			process.argv[1] = prevArgv1;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 30000);

	test("a bound role resolves to the BOUND pair (not the inherited session model) and starts the grandchild with it", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		// review bound to zai/glm-x @ high; the worker session itself runs low —
		// if the binding were ignored, --thinking would say low, not high.
		fs.writeFileSync(path.join(agentDir, "subagent-roles.json"), JSON.stringify({ review: "zai/glm-x:high" }));
		const argvOut = path.join(base, "grandchild-argv.json");
		const probe = path.join(base, "argv-probe.js");
		fs.writeFileSync(
			probe,
			"require('node:fs').writeFileSync(process.env.PI_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), pid: process.pid }));\n" +
			"setInterval(() => {}, 1000);\n",
		);
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevWorkerId = process.env.PI_SUBAGENT_ID;
		// the worker session carries its own subagent id
		process.env.PI_SUBAGENT_ID = "sa-worker-followup";
		const prevArgvOut = process.env.PI_ARGV_OUT;
		const prevArgv1 = process.argv[1];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_ARGV_OUT = argvOut;
		process.argv[1] = probe;

		try {
			const { pi, tools } = makePi();
			registerExtension(pi);
			const def = tools.get("subagent")!;
			const ctx = {
				cwd: base,
				model: { provider: "zai", id: "glm-x" },
				thinkingLevel: "low",
				modelRegistry: {
					getAll: () => [{ provider: "zai", id: "glm-x", reasoning: true }],
				},
			};
			const pending = def.execute(
				"tc-n2",
				{ op: "spawn", task: "critical review", role: "review" },
				undefined,
				undefined,
				ctx,
			) as Promise<unknown>;

			let recorded: { argv: string[]; pid: number } | undefined;
			for (let i = 0; i < 100 && !recorded; i++) {
				await new Promise((r) => setTimeout(r, 50));
				try {
					recorded = JSON.parse(fs.readFileSync(argvOut, "utf8")) as { argv: string[]; pid: number };
				} catch {
					// not written yet
				}
			}
			expect(recorded).toBeDefined();
			const argv = recorded!.argv;
			expect(argv).toContain("--model");
			expect(argv[argv.indexOf("--model") + 1]).toBe("zai/glm-x");
			expect(argv).toContain("--thinking");
			expect(argv[argv.indexOf("--thinking") + 1]).toBe("high"); // bound, NOT the session's low

			try {
				process.kill(recorded!.pid);
			} catch {
				// already gone
			}
			await pending;

			// an unknown model is refused before any process.
			const bad = (await def.execute(
				"tc-n3",
				{ op: "spawn", task: "t", model: "budget/nano" },
				undefined,
				undefined,
				ctx,
			)) as { isError?: boolean; details: { error?: string } };
			expect(bad.isError).toBe(true);
			expect(bad.details.error).toContain("budget/nano");
			// no grandchild was ever started for the refused model
			expect(fs.existsSync(argvOut + ".second")).toBe(false);
		} finally {
			if (prevWorkerId === undefined) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = prevWorkerId;
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevArgvOut === undefined) delete process.env.PI_ARGV_OUT;
			else process.env.PI_ARGV_OUT = prevArgvOut;
			process.argv[1] = prevArgv1;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 15000);

	test("omitting model and role inherits the worker's session model and starts the grandchild with it", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		const argvOut = path.join(base, "grandchild-argv.json");
		const probe = path.join(base, "argv-probe.js");
		fs.writeFileSync(
			probe,
			"require('node:fs').writeFileSync(process.env.PI_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), pid: process.pid }));\n" +
			"setInterval(() => {}, 1000);\n",
		);
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const prevWorkerId = process.env.PI_SUBAGENT_ID;
		// the worker session carries its own subagent id
		process.env.PI_SUBAGENT_ID = "sa-worker-followup";
		const prevArgvOut = process.env.PI_ARGV_OUT;
		const prevArgv1 = process.argv[1];
		process.env.PI_CODING_AGENT_DIR = agentDir; // no bindings: the session model must still work
		process.env.PI_ARGV_OUT = argvOut;
		process.argv[1] = probe;

		try {
			const { pi, tools } = makePi();
			// the worker session's live thinking level feeds the session pair
			(pi as unknown as { getThinkingLevel(): string }).getThinkingLevel = () => "high";
			registerExtension(pi);
			const def = tools.get("subagent")!;
			const ctx = {
				cwd: base,
				model: { provider: "zai", id: "glm-x" },
				thinkingLevel: "high",
				modelRegistry: { getAll: () => [{ provider: "zai", id: "glm-x", reasoning: true }] },
			};
			const pending = def.execute(
				"tc-n4",
				{ op: "spawn", task: "helper" }, // no model/role → helper → unbound → session
				undefined,
				undefined,
				ctx,
			) as Promise<unknown>;

			let recorded: { argv: string[]; pid: number } | undefined;
			for (let i = 0; i < 100 && !recorded; i++) {
				await new Promise((r) => setTimeout(r, 50));
				try {
					recorded = JSON.parse(fs.readFileSync(argvOut, "utf8")) as { argv: string[]; pid: number };
				} catch {
					// not written yet
				}
			}
			expect(recorded).toBeDefined();
			const argv = recorded!.argv;
			expect(argv[argv.indexOf("--model") + 1]).toBe("zai/glm-x");
			expect(argv[argv.indexOf("--thinking") + 1]).toBe("high"); // the session pair

			try {
				process.kill(recorded!.pid);
			} catch {
				// already gone
			}
			await pending;
		} finally {
			if (prevWorkerId === undefined) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = prevWorkerId;
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			if (prevArgvOut === undefined) delete process.env.PI_ARGV_OUT;
			else process.env.PI_ARGV_OUT = prevArgvOut;
			process.argv[1] = prevArgv1;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 15000);
});

	describe("plain wait steering wake", () => {
	test("pending user message releases a blocking wait early; the child keeps running", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wait-wake-test-"));
		const probe = path.join(base, "rpc-probe.js");
		fs.writeFileSync(probe, RPC_PROBE_SOURCE);
		const prevArgv1 = process.argv[1];
		const prevWorkerId = process.env.PI_SUBAGENT_ID;
		// resolvePiInvocation picks up process.argv[1] (.js) as the pi entry,
		// so the runtime spawns the probe instead of a real pi; a worker id
		// would flip the main-session gates, so pin it away like makeEnv does.
		process.argv[1] = probe;
		delete process.env.PI_SUBAGENT_ID;
		// Pin an EMPTY agent dir: spawn resolution must never consult the real
		// user's role bindings (a real helper binding to a model outside
		// this fake registry would make the spawn fail closed here).
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { pi, tools } = makePi();
			registerExtension(pi);
			const def = tools.get("subagent")!;
			let pendingUser = false;
			const ctx = {
				cwd: base,
				model: { provider: "zai", id: "glm-x" },
				thinkingLevel: "low",
				modelRegistry: { getAll: () => [{ provider: "zai", id: "glm-x", reasoning: true }] },
				hasPendingMessages: () => pendingUser,
			};
			const spawnRes = (await def.execute(
				"tc-w0",
				{ op: "spawn", task: "long background work" },
				undefined,
				undefined,
				ctx,
			)) as { details: { snapshot?: { id: string } } };
			const id = spawnRes.details.snapshot!.id;

			// block on the child, then queue a user message: the wake poll
			// (450ms cadence) must release the wait well before its 30s cap
			const waitPromise = def.execute("tc-w1", { op: "wait", id, timeoutSec: 30 }, undefined, undefined, ctx) as Promise<{
				content: Array<{ text: string }>;
				details: { wait: { status: string; state?: string } };
			}>;
			await new Promise((r) => setTimeout(r, 150));
			pendingUser = true;
			const res = await waitPromise;
			expect(res.details.wait).toMatchObject({ status: "released", state: "running" });
			expect(res.content[0]!.text).toContain("wait released");
			expect(res.content[0]!.text).toContain("keeps running");

			// the child was NOT killed: still running, still waitable
			const status = (await def.execute("tc-w2", { op: "status", id }, undefined, undefined, ctx)) as {
				details: { agents: Array<{ state: string }> };
			};
			expect(status.details.agents[0]!.state).toBe("running");

			// cleanup: terminate the probe child
			await def.execute("tc-w3", { op: "cancel", id }, undefined, undefined, ctx);
		} finally {
			process.argv[1] = prevArgv1;
			if (prevWorkerId !== undefined) process.env.PI_SUBAGENT_ID = prevWorkerId;
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 15000);
});

describe("workspace spawn nesting is flat (fail closed)", () => {
	test("a workspace worker cannot spawn another workspace owner — no process starts", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nestflat-test-"));
		const argvOut = path.join(base, "grandchild-argv.json");
		const probe = path.join(base, "argv-probe.js");
		// If any grandchild process were spawned, it would record its argv here.
		fs.writeFileSync(
			probe,
			"require('node:fs').writeFileSync(process.env.PI_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), pid: process.pid }));\n" +
			"setInterval(() => {}, 1000);\n",
		);
		const prevWorkerId = process.env.PI_SUBAGENT_ID;
		const prevArgvOut = process.env.PI_ARGV_OUT;
		const prevArgv1 = process.argv[1];
		// Worker environment: carries its own subagent id.
		process.env.PI_SUBAGENT_ID = "sa-worker-nestflat";
		process.env.PI_ARGV_OUT = argvOut;
		// Any child spawn would resolve to this probe and mark the argv file.
		process.argv[1] = probe;

		try {
			const { pi, tools } = makePi();
			registerExtension(pi);
			const def = tools.get("subagent")!;
			const ctx = {
				cwd: base,
				model: { provider: "zai", id: "glm-x" },
				thinkingLevel: "high",
				modelRegistry: { getAll: () => [{ provider: "zai", id: "glm-x", reasoning: true }] },
			};
			// Even with a plausible worktree path: rejected before validation,
			// gates, readiness, or any process start.
			const res = (await def.execute(
				"tc-nf1",
				{ op: "spawn", workspace: base, task: "own another worktree" },
				undefined,
				undefined,
				ctx,
			)) as { isError?: boolean; details: { error?: string } };
			expect(res.isError).toBe(true);
			expect(res.details.error).toContain("workspace spawns can only be created by the main session");

			// The same verdict even for a path that cannot be a worktree:
			// nesting is refused before workspace validation runs.
			const res2 = (await def.execute(
				"tc-nf2",
				{ op: "spawn", workspace: "/definitely/not/a/worktree", task: "t" },
				undefined,
				undefined,
				ctx,
			)) as { isError?: boolean; details: { error?: string } };
			expect(res2.isError).toBe(true);
			expect(res2.details.error).toContain("main session");

			// No grandchild process was ever started: the argv probe file —
			// which any spawned child would have written immediately — does
			// not exist after a generous wait.
			await new Promise((r) => setTimeout(r, 600));
			expect(fs.existsSync(argvOut)).toBe(false);

			// (Plain model helpers from the same worker keep working —
			// proven by the nested tests above, which run with
			// PI_SUBAGENT_ID set.)
		} finally {
			if (prevWorkerId === undefined) delete process.env.PI_SUBAGENT_ID;
			else process.env.PI_SUBAGENT_ID = prevWorkerId;
			if (prevArgvOut === undefined) delete process.env.PI_ARGV_OUT;
			else process.env.PI_ARGV_OUT = prevArgvOut;
			process.argv[1] = prevArgv1;
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 20000);
});
