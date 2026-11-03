import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSubagentRuntime } from "./controller.ts";
import { autoAcceptPrompt, createFakeSpawnFactory, settleRun } from "./fake-rpc.ts";
import registerExtension, { agentDetailView } from "./index.ts";
import { publishSubagentStateSource, type ReadOnlyStateRegistry } from "./read-only-state.ts";

const key = Symbol.for("agentkit.read-only-state.v1");
const scope = globalThis as { [key: symbol]: ReadOnlyStateRegistry | undefined };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await tick();
	}
	throw new Error("condition not met in time");
}

function saveRegistry() {
	const previous = scope[key];
	const source = previous?.subagents;
	return () => {
		if (previous) { previous.subagents = source; scope[key] = previous; }
		else delete scope[key];
	};
}

function makeRuntime() {
	const restore = saveRegistry();
	const harness = createFakeSpawnFactory();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-only-runtime-"));
	const runtime = new LocalSubagentRuntime({
		defaultCwd: tmp, resultsDir: tmp,
		piCommand: { command: "node", args: ["/fake/pi-cli.js"] },
		bridgePath: "/fake/bridge.ts", webSearchPath: "/fake/web-search.ts",
		spawnFn: harness.spawnFn, killGraceMs: 50, startTimeoutMs: 2000,
		dispatchTimeoutMs: 2000, defaultIdleExitMs: 0,
	});
	publishSubagentStateSource(() => runtime.inspect().map((snapshot) => agentDetailView(snapshot)));
	const read = () => {
		const result = scope[key]!.subagents!.read();
		if (result.status !== "ok") throw new Error(result.error.message);
		return result;
	};
	const cleanup = async () => {
		try { await runtime.shutdown(); } finally { restore(); fs.rmSync(tmp, { recursive: true, force: true }); }
	};
	return { harness, runtime, read, cleanup };
}

const askUiRequest = {
	type: "extension_ui_request", id: "q-1", method: "input", title: "ask",
	placeholder: JSON.stringify({ questions: [{ id: "q1", question: "why?", options: [{ label: "a" }, { label: "b" }] }] }),
};

describe("public state source against the live controller registry", () => {
	test("starting, running, waiting and settled-but-alive are observed", async () => {
		const { harness, runtime, read, cleanup } = makeRuntime();
		try {
			expect(read()).toEqual({ status: "ok", activity: "idle", agents: [] });
			const pending = runtime.spawn({ task: "do things", label: "lab" });
			expect(read().agents[0]!.state).toBe("starting");
			await tick();
			const proc = harness.spawned[0]!;
			autoAcceptPrompt(proc);
			const snap = await pending;
			await waitFor(() => read().agents[0]?.state === "running");
			expect(read()).toMatchObject({ activity: "active", agents: [{ id: snap.id, label: "lab", state: "running", alive: true }] });
			proc.writeToStdout(askUiRequest);
			await waitFor(() => read().agents[0]?.state === "waiting_input");
			expect(read().activity).toBe("active");
			await runtime.respond(snap.id, "because");
			await waitFor(() => read().agents[0]?.state === "running");
			settleRun(proc, "done");
			await waitFor(() => read().agents[0]?.state === "completed");
			expect(read()).toMatchObject({ activity: "idle", agents: [{ id: snap.id, state: "completed", alive: true }] });
		} finally { await cleanup(); }
	});

	test("cancel is terminal and idle", async () => {
		const { harness, runtime, read, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "x", label: "lab" });
			await tick(); autoAcceptPrompt(harness.spawned[0]!);
			const snap = await pending;
			await runtime.cancel(snap.id);
			await waitFor(() => read().agents[0]?.state === "cancelled");
			expect(read()).toMatchObject({ activity: "idle", agents: [{ id: snap.id, state: "cancelled" }] });
		} finally { await cleanup(); }
	});

	test("unexpected exit is failed and idle", async () => {
		const { harness, runtime, read, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "x", label: "lab" });
			await tick(); const proc = harness.spawned[0]!; autoAcceptPrompt(proc);
			const snap = await pending;
			proc.close(1, null);
			await waitFor(() => read().agents[0]?.state === "failed");
			expect(read()).toMatchObject({ activity: "idle", agents: [{ id: snap.id, state: "failed", alive: false }] });
		} finally { await cleanup(); }
	});

	test("clean exit before settle fetch leaves a nonterminal dead child idle", async () => {
		const { harness, runtime, read, cleanup } = makeRuntime();
		try {
			const pending = runtime.spawn({ task: "x", label: "lab" });
			await tick(); const proc = harness.spawned[0]!; autoAcceptPrompt(proc);
			const snap = await pending;
			await waitFor(() => read().agents[0]?.state === "running");
			proc.writeToStdout({ type: "agent_settled" });
			proc.close(0, null);
			await waitFor(() => read().agents[0]?.alive === false);
			expect(read()).toMatchObject({ activity: "idle", agents: [{ id: snap.id, state: "running", alive: false }] });
		} finally { await cleanup(); }
	});
});

type PiHandler = (...args: unknown[]) => unknown;

test("production registration and session lifecycle do not expose retired telemetry", async () => {
	const restore = saveRegistry();
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "read-only-wiring-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = base;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, unknown>();
	const handlers = new Map<string, PiHandler[]>();
	const wire: unknown[] = [];
	const pi = {
		registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(def.name, def),
		registerCommand: (name: string, def: unknown) => commands.set(name, def),
		sendMessage: () => {}, getThinkingLevel: () => "off",
		on: (event: string, handler: PiHandler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: base, mode: "rpc", modelRegistry: { getRegisteredProviderIds: () => [], getAll: () => [] },
		isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined },
		ui: { setStatus: (...args: unknown[]) => wire.push(args), notify: () => {}, input: async () => undefined },
	};
	const fire = async (event: string, ...args: unknown[]) => {
		for (const handler of handlers.get(event) ?? []) await handler(...args);
	};
	let shutdown = false;
	try {
		registerExtension(pi);
		expect(commands.has("agentkit-status")).toBe(false);
		expect(scope[key]!.subagents!.read()).toEqual({ status: "ok", activity: "idle", agents: [] });
		await fire("session_start", {}, ctx);
		await tools.get("subagent")!.execute("tc-1", { op: "status" }, undefined, undefined, ctx);
		expect(scope[key]!.subagents!.read()).toEqual({ status: "ok", activity: "idle", agents: [] });
		await fire("session_shutdown");
		shutdown = true;
		expect(wire).toEqual([]);
	} finally {
		if (!shutdown) await fire("session_shutdown");
		restore();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(base, { recursive: true, force: true });
	}
});
