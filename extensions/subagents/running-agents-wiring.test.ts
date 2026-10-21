/**
 * Emission wiring for the running-agents push: the real controller registry
 * drives frames through the records-changed hook, and the shipped extension
 * captures the RPC gate from session_start. Frame formatting/dedup/budget
 * semantics are unit-tested in running-agents-push.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller";
import {
	attachRunningAgentsPush,
	RUNNING_AGENTS_STATUS_KEY,
	type RunningAgentRow,
	type RunningAgentsPush,
} from "./running-agents-push";
import { autoAcceptPrompt, createFakeSpawnFactory, settleRun } from "./fake-rpc";
import registerExtension from "./index";

interface WireFrame {
	key: string;
	text: string | undefined;
}

interface ParsedFrame {
	v: number;
	agents: RunningAgentRow[];
	count: number;
	truncated: boolean;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await tick(5);
	}
	throw new Error("condition not met in time");
}

function makeRuntime() {
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "running-agents-test-"));
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp,
		resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts",
		webSearchPath: "/fake/web-search.ts",
		spawnFn: harness.spawnFn,
		killGraceMs: 50,
		startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000,
		defaultIdleExitMs: 0, // terminal records stay; no idle-exit timers in tests
	});
	const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	return { harness, runtime, cleanup };
}

/** Attach the push to a live runtime and record the wire writes. */
function makePush(runtime: LocalSubagentRuntime, mode = "rpc") {
	const wire: WireFrame[] = [];
	const push: RunningAgentsPush = attachRunningAgentsPush(runtime, {
		mode,
		ui: {
			setStatus: (key: string, text?: string) => {
				wire.push({ key, text });
			},
		},
	});
	const frames = (): ParsedFrame[] => wire.map((f) => JSON.parse(f.text ?? "null") as ParsedFrame);
	const last = (): ParsedFrame => frames()[frames().length - 1]!;
	return { push, wire, frames, last };
}

const askPayload = (id: string, question: string) =>
	JSON.stringify({ questions: [{ id, question, options: [{ label: "a" }, { label: "b" }] }] });
const askUiRequest = (reqId: string, payload: string) => ({
	type: "extension_ui_request",
	id: reqId,
	method: "input",
	title: "ask",
	placeholder: payload,
});

describe("running-agents push against the live controller registry", () => {
	test("spawn, waiting_input, resume, terminal and shutdown produce truthful frames", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		const { push, wire, last } = makePush(runtime);
		try {
			expect(wire).toHaveLength(1);
			expect(last()).toEqual({ v: 1, agents: [], count: 0, truncated: false });

			// Spawn registers the record as `starting` synchronously.
			const pending = runtime.spawn({ task: "do things", label: "lab" });
			expect(last().count).toBe(1);
			expect(last().agents[0]!.state).toBe("starting");
			const agentId = last().agents[0]!.id;

			await tick(5);
			const proc = harness.spawned[0]!;
			autoAcceptPrompt(proc);
			await pending;
			await waitFor(() => last().agents[0]?.state === "running");
			expect(last()).toMatchObject({ count: 1, truncated: false });
			expect(last().agents[0]).toEqual({ id: agentId, label: "lab", state: "running" });

			// waiting_input is part of the running set, and its resolution is too.
			proc.writeToStdout(askUiRequest("q-1", askPayload("q1", "why?")));
			await waitFor(() => last().agents[0]?.state === "waiting_input");
			await runtime.respond(agentId, "because");
			await waitFor(() => last().agents[0]?.state === "running");

			// An unchanged set emits nothing, even when the child re-announces a run.
			const framesBefore = wire.length;
			proc.writeToStdout({ type: "agent_start" });
			await tick(20);
			expect(wire.length).toBe(framesBefore);

			// Terminal settlement removes the row.
			settleRun(proc, "done");
			await waitFor(() => last().count === 0);
			expect(last()).toEqual({ v: 1, agents: [], count: 0, truncated: false });

			// Shutdown emits an unconditional empty frame.
			const beforeShutdown = wire.length;
			push.shutdown();
			expect(wire.length).toBe(beforeShutdown + 1);
			expect(last()).toEqual({ v: 1, agents: [], count: 0, truncated: false });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("cancel removes the agent from the set", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		const { last } = makePush(runtime);
		try {
			const pending = runtime.spawn({ task: "x", label: "lab" });
			await tick(5);
			const proc = harness.spawned[0]!;
			autoAcceptPrompt(proc);
			const snap = await pending;
			await waitFor(() => last().agents[0]?.state === "running");

			await runtime.cancel(snap.id);
			await waitFor(() => last().count === 0);
			expect(last()).toEqual({ v: 1, agents: [], count: 0, truncated: false });
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});

	test("an unexpected process exit removes the agent (failed)", async () => {
		const { harness, runtime, cleanup } = makeRuntime();
		const { last } = makePush(runtime);
		try {
			const pending = runtime.spawn({ task: "x", label: "lab" });
			await tick(5);
			const proc = harness.spawned[0]!;
			autoAcceptPrompt(proc);
			await pending;
			await waitFor(() => last().count === 1);

			proc.close(1, null);
			await waitFor(() => last().count === 0);
			expect(last().agents).toEqual([]);
		} finally {
			await runtime.shutdown();
			cleanup();
		}
	});
});

// ------------------------------------------------------- extension-level gate

type PiHandler = (...args: unknown[]) => unknown;

function makePi() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, PiHandler[]>();
	const events = {
		on: () => () => {},
		emit: () => {},
	};
	const pi = {
		registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		sendMessage: () => {},
		getThinkingLevel: () => "off",
		on: (event: string, handler: PiHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const i = list.indexOf(handler);
				if (i !== -1) list.splice(i, 1);
			};
		},
		events,
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers };
}

async function fire(handlers: Map<string, PiHandler[]>, event: string, ...args: unknown[]): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(...args);
}

/** Sandbox the agent dir so the lazily created runtime never touches user state. */
function makeEnv() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "running-agents-wiring-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = base;
	return {
		base,
		restore() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			fs.rmSync(base, { recursive: true, force: true });
		},
	};
}

function makeSessionCtx(cwd: string, mode: string, wire: WireFrame[]) {
	return {
		cwd,
		mode,
		modelRegistry: { getRegisteredProviderIds: () => [], getAll: () => [] },
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => undefined },
		ui: {
			setStatus: (key: string, text?: string) => {
				wire.push({ key, text });
			},
			notify: () => {},
			input: async () => undefined,
		},
	};
}

const emptyFrame = { v: 1, agents: [], count: 0, truncated: false };

describe("running-agents push extension wiring", () => {
	test("rpc session: creation frame at runtime start, empty frame at shutdown", async () => {
		const env = makeEnv();
		try {
			const { pi, tools, handlers } = makePi();
			registerExtension(pi);
			const wire: WireFrame[] = [];
			const ctx = makeSessionCtx(env.base, "rpc", wire);
			await fire(handlers, "session_start", {}, ctx);
			expect(wire).toEqual([]); // no runtime yet — nothing to report

			await tools.get("subagent")!.execute("tc-1", { op: "status" }, undefined, undefined, ctx);
			expect(wire).toHaveLength(1);
			expect(wire[0]!.key).toBe(RUNNING_AGENTS_STATUS_KEY);
			expect(JSON.parse(wire[0]!.text!)).toEqual(emptyFrame);

			await fire(handlers, "session_shutdown");
			expect(wire).toHaveLength(2);
			expect(wire[1]!.key).toBe(RUNNING_AGENTS_STATUS_KEY);
			expect(JSON.parse(wire[1]!.text!)).toEqual(emptyFrame);
		} finally {
			env.restore();
		}
	});

	test("tui session: the emitter is inert end to end", async () => {
		const env = makeEnv();
		try {
			const { pi, tools, handlers } = makePi();
			registerExtension(pi);
			const wire: WireFrame[] = [];
			const ctx = makeSessionCtx(env.base, "tui", wire);
			await fire(handlers, "session_start", {}, ctx);
			await tools.get("subagent")!.execute("tc-1", { op: "status" }, undefined, undefined, ctx);
			await fire(handlers, "session_shutdown");
			expect(wire).toEqual([]);
		} finally {
			env.restore();
		}
	});
});
