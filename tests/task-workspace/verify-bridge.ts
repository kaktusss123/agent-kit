/**
 * Deterministic workspace_agent bridge tests: the REAL stock SDK drives a
 * RepoOwner session whose "model" is a scripted mock — no provider, no OMP
 * runtime. Proves, end to end through the public surface:
 *
 *  B1 capability detection fails closed before dispatch (unsupported)
 *  B2 workspace validation (primary checkout is not a valid target)
 *  B3 rooted write: child bash writes a RELATIVE path into the managed worktree
 *  B4 target project context delivered; foreign repo context does not leak
 *  B5 project-local extension of the workspace discovered and executable
 *  B6 workspace_agent removed from child active tools; stock task preserved
 *  B7 child session rooted at the workspace (SessionManager cwd)
 *  B8 no-yield run classifies as blocked with mutation warning, no fallback
 *  B9 deadline fires: partial result, child aborted and disposed
 *
 * Requires the stock source checkout for SDK/test-mock imports (test-only
 * dependency; the shipped extension never imports it). Run after
 * build-fixture.sh.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/tmp/omp-taskws";
const EXTENSIONS_DIR =
	process.env.TW_EXTENSIONS_DIR ??
	path.join(import.meta.dir, "..", "..", "dot_omp", "private_agent", "extensions");
const OMP_SRC =
	process.env.TW_OMP_SRC ??
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/coding-agent/src";
interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}

if (await fs.stat(`${FIXTURE}/.tw-run-complete`).then(() => true).catch(() => false)) {
	console.error("Fixture already consumed — re-run build-fixture.sh before this suite.");
	process.exit(2);
}

const SDK = await import(`${OMP_SRC}/index.ts`);
const { createMockModel, registerMockApi } = await import(
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/ai/src/providers/mock.ts"
);
registerMockApi();
const omptype = await import(
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/omptype/src/typebox.ts"
);
const { AuthStorage } = await import(`${OMP_SRC}/session/auth-storage.ts`);
const { ModelRegistry } = await import(`${OMP_SRC}/config/model-registry.ts`);

const MARKER_B = "AGENTS-BRIDGE-MARKER-B";
const FOREIGN_A = "AGENTS-PRODUCER-MARKER-A";

// ─── bridge workspace: dedicated source repo with a recorder extension ──
const RECORDER_TS = `export default function (pi: any) {
	pi.registerTool({
		name: "bridge_probe_tool",
		label: "Bridge Probe Tool",
		description: "project-local probe tool of the bridge workspace",
		parameters: pi.typebox.Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "BRIDGE-PROBE-OK" }] }),
	});
	const record = (info: unknown) => {
		const g = globalThis as Record<string, unknown>;
		const list = (g.__BRIDGE_PROBE__ as unknown[]) ?? [];
		list.push(info);
		g.__BRIDGE_PROBE__ = list;
	};
	pi.on("session_start", (_e: unknown, ctx: any) => {
		try {
			record({
				kind: "session_start",
				tools: pi.getActiveTools(),
				cwd: ctx.sessionManager?.getCwd?.() ?? null,
			});
		} catch (e) {
			record({ kind: "session_start_error", error: String(e) });
		}
	});
	pi.on("agent_end", () => {
		record({ kind: "agent_end" });
	});
}
`;
const BRIDGE_SRC = `${FIXTURE}/work/bridge-src`;
await fs.mkdir(`${BRIDGE_SRC}/.omp/extensions`, { recursive: true });
await fs.writeFile(`${BRIDGE_SRC}/AGENTS.md`, `${MARKER_B}: bridge workspace project context\n`);
await fs.writeFile(`${BRIDGE_SRC}/.omp/extensions/bridge-recorder.ts`, RECORDER_TS);
sh("git init -q --bare -b main ../remotes/bridge.git", BRIDGE_SRC);
sh("git init -q -b main .", BRIDGE_SRC);
sh("git config user.email fixture@local && git config user.name fixture", BRIDGE_SRC);
sh("git remote add origin ../remotes/bridge.git", BRIDGE_SRC);
sh("git add -A && git commit -qm 'bridge baseline'", BRIDGE_SRC);
sh("git push -q origin main", BRIDGE_SRC);

// managed worktree through the deterministic runtime tools
const twTools = new Map<string, any>();
{
	const pi: any = {
		registerTool: (t: { name: string; execute: Function }) => twTools.set(t.name, t),
		on: () => {},
		typebox: omptype,
	};
	const mod = await import(path.join(EXTENSIONS_DIR, "task-workspace.ts"));
	mod.default(pi);
}
async function twCall(name: string, params: Record<string, unknown>): Promise<any> {
	const tool = twTools.get(name);
	const res = (await tool.execute("probe", params, undefined, undefined, { cwd: FIXTURE })) as ToolResult;
	return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
}
const ensured = await twCall("ensure_task_repo", {
	branch: "feat/BRIDGE-1",
	source_path: BRIDGE_SRC,
	base_ref: "main",
});
if (ensured.status !== "created" && ensured.status !== "reused") {
	console.error(`ensure_task_repo failed: ${JSON.stringify(ensured)}`);
	process.exit(1);
}
const WORKSPACE = String(ensured.worktree);

// ─── workspace_agent under test ─────────────────────────────────────────
const tools = new Map<string, any>();
const eventHandlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
const piMock: any = {
	registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t),
	on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
		eventHandlers.set(event, handler);
	},
	typebox: omptype,
	pi: SDK,
};
const waMod = await import(path.join(EXTENSIONS_DIR, "workspace-agent.ts"));
waMod.default(piMock);

const authStorage = await AuthStorage.create(":memory:");
authStorage.setRuntimeApiKey("mock", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

function mockResponse(content: unknown, stopReason: string): unknown {
	return {
		content,
		stopReason,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function toolCall(name: string, args: unknown): unknown {
	return mockResponse([{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }], "toolUse");
}
function yieldCall(data: unknown): unknown {
	return toolCall("yield", { result: { data, complete: true } });
}

async function runBridge(model: unknown, params: Record<string, unknown>): Promise<any> {
	const tool = tools.get("workspace_agent");
	const res = (await tool.execute("probe", params, undefined, undefined, { cwd: FIXTURE })) as ToolResult;
	return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
}
function fireTurnStart(model: unknown): void {
	eventHandlers.get("turn_start")?.({ type: "turn_start" }, { model, modelRegistry });
}

function ok(cond: boolean, label: string): void {
	console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
	if (!cond) process.exitCode = 1;
}
function section(title: string): void {
	console.log(`\n=== ${title} ===`);
}
function sh(cmd: string, dir: string): string {
	const out = Bun.spawnSync(["bash", "-c", cmd], { cwd: dir });
	return out.stdout.toString().trim();
}

// ─── B1: missing SDK capability fails closed ────────────────────────────
section("B1 capability detection");
{
	const bareTools = new Map<string, any>();
	const barePi: any = {
		registerTool: (t: { name: string; execute: Function }) => bareTools.set(t.name, t),
		on: () => {},
		typebox: omptype,
		// pi deliberately absent: pre-capability OMP
	};
	waMod.default(barePi);
	const tool = bareTools.get("workspace_agent");
	const res = (await tool.execute("probe", { workspace: WORKSPACE, task: "x" }, undefined, undefined, {
		cwd: FIXTURE,
	})) as ToolResult;
	const out = JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
	ok(
		out.status === "unsupported" && out.dispatched === false,
		`missing pi.pi returns unsupported, dispatched=false (got ${JSON.stringify(out)})`,
	);
}

// ─── B2: primary checkout is not a valid workspace_agent target ─────────
section("B2 workspace validation");
{
	const neverModel = createMockModel({
		handler: () => mockResponse(["should never be called"], "stop"),
	});
	fireTurnStart(neverModel.model);
	const out = await runBridge(neverModel.model, {
		workspace: `${FIXTURE}/work/consumer`,
		task: "x",
	});
	ok(
		out.status === "unsupported" && out.dispatched === false,
		`primary checkout rejected pre-dispatch (got ${JSON.stringify(out)})`,
	);
}

// ─── B3–B7: happy path ──────────────────────────────────────────────────
section("B3-B7 rooted RepoOwner happy path");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	let calls = 0;
	const handler = (context: unknown): unknown => {
		calls++;
		const ctxText = JSON.stringify(context);
		if (calls === 1) return toolCall("bash", { command: "printf rooted > probe.txt" });
		if (calls === 2) return toolCall("bridge_probe_tool", {});
		const sawB = ctxText.includes(MARKER_B);
		const sawForeign = ctxText.includes(FOREIGN_A);
		const sawProbe = ctxText.includes("BRIDGE-PROBE-OK");
		return yieldCall({
			status: "done",
			summary: JSON.stringify({ sawB, sawForeign, sawProbe }),
			verification: [{ check: "probe", result: sawProbe ? "pass" : "fail" }],
			gaps: [],
		});
	};
	const model = createMockModel({ handler: handler as never });
	fireTurnStart(model.model);
	const out = await runBridge(model.model, {
		workspace: WORKSPACE,
		task: "Implement the probe scenario. Write with relative paths.",
	});
	ok(out.status === "done" && out.dispatched === true, `bridge completed (got ${JSON.stringify(out).slice(0, 300)})`);
	const summary = JSON.parse(String((out.result as any)?.summary ?? "{}"));
	ok(summary.sawB === true, "target repo project context delivered to the child");
	ok(summary.sawForeign === false, "foreign repo context did not leak");
	ok(summary.sawProbe === true, "project-local extension tool of the workspace executed");
	ok(
		sh("test -f probe.txt && cat probe.txt", WORKSPACE) === "rooted",
		"child wrote RELATIVE path into the managed worktree",
	);
	ok(
		!sh("test -f probe.txt && echo present", `${FIXTURE}/work/producer`).includes("present") &&
			!sh("test -f probe.txt && echo present", BRIDGE_SRC).includes("present"),
		"rooted write did not land in the source checkout or sibling repos",
	);
	const probe = ((globalThis as Record<string, unknown>).__BRIDGE_PROBE__ ?? []) as Array<any>;
	const kinds = probe.map((p) => p.kind);
	const sessionStart = probe.find((p) => p.kind === "session_start");
	ok(Boolean(sessionStart), `child session_start observed (events: ${kinds.join(",") || "none"})`);
	ok(sessionStart?.cwd === WORKSPACE, `child SessionManager rooted at the workspace (got ${sessionStart?.cwd})`);
	const childTools = (sessionStart?.tools ?? []) as string[];
	ok(!childTools.includes("workspace_agent"), "workspace_agent removed from child active tools");
	ok(childTools.includes("task"), "stock task preserved in child active tools");
}

// ─── B8: no structured yield → blocked, no fallback ─────────────────────
section("B8 no-yield classification");
{
	const model = createMockModel({ handler: () => mockResponse(["still working"], "stop") });
	fireTurnStart(model.model);
	const out = await runBridge(model.model, {
		workspace: WORKSPACE,
		task: "Work but never yield.",
	});
	ok(
		out.status === "blocked" &&
			out.dispatched === true &&
			out.child_may_have_mutated_repo === true,
		`no-yield run is blocked with mutation warning and no fallback (got ${JSON.stringify(out).slice(0, 300)})`,
	);
}

// ─── B9: deadline aborts the child and returns partial ──────────────────
section("B9 deadline");
{
	const model = createMockModel({
		handler: () => toolCall("bash", { command: "sleep 30" }),
	});
	fireTurnStart(model.model);
	const started = Date.now();
	const out = await runBridge(model.model, {
		workspace: WORKSPACE,
		task: "Sleep forever.",
		timeout_ms: 3000,
	});
	const elapsed = Date.now() - started;
	ok(
		out.status === "partial" && out.child_may_have_mutated_repo === true,
		`deadline returns partial with mutation warning (got ${JSON.stringify(out).slice(0, 240)})`,
	);
	ok(elapsed < 15000, `deadline honored in ${elapsed}ms (child aborted, not waited out)`);
}

console.log(`\nbridge scenario run complete on ${path.join(EXTENSIONS_DIR, "workspace-agent.ts")}`);
