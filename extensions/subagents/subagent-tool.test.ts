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
	const previous = process.env.AGENT_TASK_ROOT;
	process.env.AGENT_TASK_ROOT = fs.realpathSync(taskRootRaw);
	return {
		base,
		taskRoot: fs.realpathSync(taskRootRaw),
		restore() {
			if (previous === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previous;
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
