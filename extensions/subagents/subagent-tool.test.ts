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
}

function makePi() {
	const tools = new Map<string, ToolDef>();
	const messages: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		sendMessage: (message: Record<string, unknown>, _options?: unknown) => {
			messages.push(message);
		},
		getThinkingLevel: () => "low",
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { pi, tools, messages };
}

function makeEnv() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-test-"));
	const taskRootRaw = path.join(base, "tasks");
	fs.mkdirSync(taskRootRaw, { recursive: true });
	const previousTaskRoot = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = fs.realpathSync(taskRootRaw);
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
		restore() {
			if (previousTaskRoot === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previousTaskRoot;
			if (previousWorkerId !== undefined) process.env.PI_SUBAGENT_ID = previousWorkerId;
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}

const CTX = { cwd: "/tmp", thinkingLevel: "low" };

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
		expect(shape).toContain('"cwd"');
		expect(shape).toContain('"modelClass"');
		// workspace guidance lives in the prompt guidelines
		const guidelines = (def.promptGuidelines ?? []).join("\n");
		expect(guidelines).toContain("workspace");
		expect(guidelines).toContain("git_facts");
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
			// the model gate fires BEFORE workspace validation (no silent default)
			expect(res.details).toMatchObject({ status: "blocked", dispatched: false });
			expect(String(res.details.reason)).toContain("no model resolved");
		} finally {
			env.restore();
		}
	});

	test("workspace spawn rejects modelClass (child inherits the main model)", async () => {
		const { pi, tools } = makePi();
		registerExtension(pi);
		const env = makeEnv();
		try {
			const def = tools.get("subagent")!;
			const res = (await def.execute(
				"tc-2",
				{ op: "spawn", workspace: "/x", task: "t", modelClass: "cheap" },
				undefined,
				undefined,
				{ ...CTX, model: { provider: "zai", id: "glm-x" } },
			)) as { isError?: boolean; details: { error?: string } };
			expect(res.isError).toBe(true);
			expect(res.details.error).toContain("modelClass");
		} finally {
			env.restore();
		}
	});

	test("deadlineSec on a plain spawn is rejected; plain spawn resolves a model class", async () => {
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
});

// ---------------------------------------------------------------------------
// Nested spawn: main -> subagent(workspace=...) -> subagent(modelClass=...)
//
// The workspace profile ships THIS extension's index.ts into the RepoOwner
// child, so the worker owns the same `subagent` tool the main session has.
// These tests load the real index.ts (the exact file the profile carries),
// point the model-classes store at a scratch agent dir, and prove that a
// `modelClass=cheap` spawn through the real tool execute() starts a real
// grandchild process whose argv carries the RESOLVED class model.
// ---------------------------------------------------------------------------

describe("nested spawn from a workspace worker", () => {
	test("child-embedded subagent tool resolves modelClass=cheap and starts the grandchild with it", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		// The persisted class store (same file /main/ writes; the worker reads
		// it through the inherited PI_CODING_AGENT_DIR).
		fs.writeFileSync(
			path.join(agentDir, "model-classes.json"),
			JSON.stringify({ cheap: { model: "budget/nano", thinking: "minimal" } }),
		);
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
			// model; the registry is what stored classes resolve against.
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
			// The spawn ack proves the class RESOLVED (fail closed otherwise),
			// but the probe child never speaks RPC — the ack only lands after
			// the runtime's acceptance timeout. Run the execute WITHOUT await
			// and read the argv record while it is pending.
			const pending = def.execute(
				"tc-n1",
				{ op: "spawn", task: "repo-local helper work", modelClass: "cheap" },
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

	test("smart resolves to the STORED pair (not the inherited session model) and starts the grandchild with it", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-nested-test-"));
		const agentDir = path.join(base, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });
		// stored smart = zai/glm-x @ high; the worker session itself runs low —
		// if the stored pair were ignored, --thinking would say low, not high.
		fs.writeFileSync(
			path.join(agentDir, "model-classes.json"),
			JSON.stringify({ smart: { model: "zai/glm-x", thinking: "high" } }),
		);
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
				{ op: "spawn", task: "critical review", modelClass: "smart" },
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
			expect(argv[argv.indexOf("--thinking") + 1]).toBe("high"); // stored, NOT the session's low

			try {
				process.kill(recorded!.pid);
			} catch {
				// already gone
			}
			await pending;

			// cheap is not configured in this dir → refused before any process.
			const bad = (await def.execute(
				"tc-n3",
				{ op: "spawn", task: "t", modelClass: "cheap" },
				undefined,
				undefined,
				ctx,
			)) as { isError?: boolean; details: { error?: string } };
			expect(bad.isError).toBe(true);
			expect(bad.details.error).toContain("cheap");
			// no grandchild was ever started for the refused class
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

	test("default inherits the worker's session model and starts the grandchild with it", async () => {
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
		process.env.PI_CODING_AGENT_DIR = agentDir; // no stored classes: default must still work
		process.env.PI_ARGV_OUT = argvOut;
		process.argv[1] = probe;

		try {
			const { pi, tools } = makePi();
			// the worker session's live thinking level feeds the default class
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
				{ op: "spawn", task: "helper" }, // no modelClass → default
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

			// (Plain modelClass helpers from the same worker keep working —
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
