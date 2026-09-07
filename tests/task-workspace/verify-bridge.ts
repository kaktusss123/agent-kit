/**
 * Deterministic workspace_agent bridge tests: the REAL stock SDK drives
 * RepoOwner sessions whose "model" is a scripted mock — no provider, no OMP
 * runtime. Proves, end to end through the public surface:
 *
 *  B1 capability detection fails closed before dispatch (unsupported)
 *  B2 workspace validation (primary checkout is not a valid target)
 *  B3 rooted write: child bash writes a RELATIVE path into the managed worktree
 *  B4 context semantics: .omp/AGENTS.md shadows root AGENTS.md
 *  B5 SYSTEM.md is NOT project context (negative: marker must not leak)
 *  B6 root AGENTS.md fallback when no .omp/AGENTS.md exists
 *  B7 project-local extension of the workspace discovered and executable
 *  B8 workspace_agent removed from child active tools; stock task preserved
 *  B9 child session rooted at the workspace (SessionManager cwd)
 *  B10 per-invocation model: two calls with different caller models pin each
 *      child to its own invocation model (no lifecycle cache)
 *  B11 parallel RepoOwners: isolated worktrees, files, registries; both yield
 *  B12 failure isolation: an aborted owner does not terminate a concurrent one
 *  B13 no-yield run classifies as blocked with mutation warning, no fallback
 *  B14 deadline fires: partial result, child aborted and disposed
 *
 * Requires the stock source checkout for SDK/test-mock imports (test-only
 * dependency; the shipped extension never imports it). Run after
 * build-fixture.sh.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/var/tmp/omp-taskws";
const EXTENSIONS_DIR =
	process.env.TW_EXTENSIONS_DIR ??
	path.join(import.meta.dir, "..", "..", "dot_omp", "private_agent", "extensions");
const OMP_SRC =
	process.env.TW_OMP_SRC ??
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/coding-agent/src";
const MOCK_PATH =
	process.env.TW_MOCK_PATH ??
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/ai/src/providers/mock.ts";
const OMPTYPE_PATH =
	process.env.TW_OMPTYPE_PATH ??
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/omptype/src/typebox.ts";
process.env.OMP_TASK_ROOT = `${FIXTURE}/tasks`;

if (await fs.stat(`${FIXTURE}/.tw-run-complete`).then(() => true).catch(() => false)) {
	console.error("Fixture already consumed — re-run build-fixture.sh before this suite.");
	process.exit(2);
}

const SDK = await import(`${OMP_SRC}/index.ts`);
const { createMockModel, registerMockApi } = await import(MOCK_PATH);
registerMockApi();
const omptype = await import(OMPTYPE_PATH);
const { AuthStorage } = await import(`${OMP_SRC}/session/auth-storage.ts`);
const { ModelRegistry } = await import(`${OMP_SRC}/config/model-registry.ts`);

// ─── bridge workspaces: B (shadowing + SYSTEM negative), C (fallback) ───
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
				modelId: ctx.model?.id ?? null,
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
async function makeBridgeRepo(name: string, opts: { ompAgents?: string; rootAgents?: string; systemMd?: string }): Promise<string> {
	const dir = `${FIXTURE}/work/${name}`;
	await fs.mkdir(`${dir}/.omp/extensions`, { recursive: true });
	if (opts.rootAgents) await fs.writeFile(`${dir}/AGENTS.md`, `${opts.rootAgents}\n`);
	if (opts.ompAgents) await fs.writeFile(`${dir}/.omp/AGENTS.md`, `${opts.ompAgents}\n`);
	if (opts.systemMd) await fs.writeFile(`${dir}/SYSTEM.md`, `${opts.systemMd}\n`);
	await fs.writeFile(`${dir}/.omp/extensions/bridge-recorder.ts`, RECORDER_TS);
	sh(`git init -q --bare -b main ../remotes/${name}.git`, dir);
	sh("git init -q -b main .", dir);
	sh("git config user.email fixture@local && git config user.name fixture", dir);
	sh(`git remote add origin ../remotes/${name}.git`, dir);
	sh("git add -A && git commit -qm 'bridge baseline'", dir);
	sh("git push -q origin main", dir);
	return dir;
}
const B_SRC = await makeBridgeRepo("bridge-b", {
	ompAgents: "MARKER-OMPDIR-AGENTS-B",
	rootAgents: "MARKER-ROOT-AGENTS-B",
	systemMd: "UNIQUE_SYSTEM_MARKER_B",
});
const C_SRC = await makeBridgeRepo("bridge-c", {
	rootAgents: "MARKER-ROOT-AGENTS-C",
});

// managed worktrees through the deterministic runtime tools
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
async function ensureWorktree(branch: string, source: string): Promise<string> {
	const out = await twCall("ensure_task_repo", { branch, source_path: source, base_ref: "main" });
	if (out.status !== "created" && out.status !== "reused") {
		console.error(`ensure_task_repo failed: ${JSON.stringify(out)}`);
		process.exit(1);
	}
	return String(out.worktree);
}
const WORKSPACE_B = await ensureWorktree("feat/BRIDGE-B", B_SRC);
const WORKSPACE_C = await ensureWorktree("feat/BRIDGE-C", C_SRC);

// ─── workspace_agent under test ─────────────────────────────────────────
interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}
const tools = new Map<string, any>();
const piMock: any = {
	registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t),
	on: () => {},
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
function scriptModel(id: string, handler: (context: unknown) => unknown): unknown {
	return createMockModel({ id, handler: handler as never }).model;
}
async function runBridge(model: unknown, params: Record<string, unknown>): Promise<any> {
	const tool = tools.get("workspace_agent");
	const res = (await tool.execute("probe", params, undefined, undefined, {
		cwd: FIXTURE,
		model,
		modelRegistry,
	})) as ToolResult;
	return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
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
	const res = (await tool.execute("probe", { workspace: WORKSPACE_B, task: "x" }, undefined, undefined, {
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
	const neverModel = scriptModel("mock-never", () => mockResponse(["should never run"], "stop"));
	const out = await runBridge(neverModel, {
		workspace: `${FIXTURE}/work/producer`,
		task: "x",
	});
	ok(
		out.status === "unsupported" && out.dispatched === false,
		`primary checkout rejected pre-dispatch (got ${JSON.stringify(out)})`,
	);
}

// ─── mock-transport canary ──────────────────────────────────────────────
// The scripted "mock" API is not part of the provider catalog: whether it can
// stream through the high-level createAgentSession transport is SDK-version
// dependent (18.1.9 routes it; 18.1.10's mapOptionsForApi has no custom-API
// branch and throws). Probe once; model-streaming sections are meaningful
// only when the canary passes.
const MOCK_UNSUPPORTED_RE = /Unhandled API in mapOptionsForApi: mock/i;
const MOCK_TRANSPORT_OK = await (async (): Promise<boolean> => {
	const canary = scriptModel("mock-canary", () => mockResponse(["ok"], "stop"));
	const sm = SDK.SessionManager.inMemory(FIXTURE);
	let session: AgentSession | undefined;
	let failure: string | undefined;
	try {
		const created = await SDK.createAgentSession({
			cwd: FIXTURE,
			sessionManager: sm,
			agentRegistry: new SDK.AgentRegistry(),
			model: canary,
			modelRegistry,
			autoApprove: true,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
		});
		session = created.session;
		const run = (async () => {
			await session!.prompt("Reply with exactly: ok");
			await session!.waitForIdle();
		})();
		await Promise.race([
			run,
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error("canary timed out after 60s")), 60000),
			),
		]);
		const last = session.getLastAssistantMessage();
		if (!last) {
			failure = "no assistant message produced";
		} else if (last.stopReason === "error") {
			failure = String((last as { errorMessage?: string }).errorMessage ?? "model error");
		}
	} catch (e) {
		failure = (e as Error).message;
	} finally {
		try {
			await session?.dispose();
		} catch {
			// best-effort canary cleanup
		}
	}
	if (failure === undefined) return true;
	if (!MOCK_UNSUPPORTED_RE.test(failure)) {
		// Any failure outside the known unsupported-transport signature is a real
		// regression in this SDK — surface it as FAIL, never as SKIP.
		console.error(
			`FAIL: mock-transport canary failed with an unexpected error (real regression, not a known SDK limitation): ${failure}`,
		);
		process.exit(1);
	}
	console.log(`canary: mock transport unsupported on this SDK — ${failure}`);
	return false;
})();

if (!MOCK_TRANSPORT_OK) {
	const SKIPPED_SECTIONS = [
		"B3-B9 rooted RepoOwner happy path",
		"B6 root AGENTS.md fallback",
		"B10 per-invocation ctx.model",
		"B11 parallel RepoOwners",
		"B12 failure isolation",
		"B13 no-yield classification",
		"B14 deadline",
	];
	for (const label of SKIPPED_SECTIONS) {
		console.log(
			`SKIP: ${label} — scripted mock transport is not streamable through createAgentSession on this SDK (upstream maps mock via the low-level Agent only); these scenarios are covered on supported SDK versions`,
		);
	}
	console.log(
		"\nbridge scenario run complete (PARTIAL: model-streaming sections skipped, provider-free assertions still executed)",
	);
	process.exit(process.exitCode ?? 0);
}

section("B3-B9 rooted RepoOwner happy path");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	let calls = 0;
	const handler = (context: unknown): unknown => {
		calls++;
		const ctxText = JSON.stringify(context);
		if (calls === 1) return toolCall("bash", { command: "printf rooted > probe.txt" });
		if (calls === 2) return toolCall("bridge_probe_tool", {});
		const sawOmpdirB = ctxText.includes("MARKER-OMPDIR-AGENTS-B");
		const sawRootB = ctxText.includes("MARKER-ROOT-AGENTS-B");
		const sawSystemB = ctxText.includes("UNIQUE_SYSTEM_MARKER_B");
		const sawProbe = ctxText.includes("BRIDGE-PROBE-OK");
		return yieldCall({
			status: "done",
			summary: JSON.stringify({ sawOmpdirB, sawRootB, sawSystemB, sawProbe }),
			verification: [{ check: "probe", result: sawProbe ? "pass" : "fail" }],
			gaps: [],
		});
	};
	const out = await runBridge(scriptModel("mock-main", handler), {
		workspace: WORKSPACE_B,
		task: "Implement the probe scenario. Write with relative paths.",
	});
	ok(out.status === "done" && out.dispatched === true, `bridge completed (got ${JSON.stringify(out).slice(0, 300)})`);
	const summary = JSON.parse(String((out.result as any)?.summary ?? "{}"));
	ok(summary.sawOmpdirB === true, "B4 .omp/AGENTS.md project context delivered to the child");
	ok(summary.sawRootB === false, "B4 shadowed root AGENTS.md NOT delivered when .omp/AGENTS.md exists");
	ok(summary.sawSystemB === false, "B5 SYSTEM.md marker never reaches the child context");
	ok(summary.sawProbe === true, "B7 project-local extension tool of the workspace executed");
	ok(
		sh("test -f probe.txt && cat probe.txt", WORKSPACE_B) === "rooted",
		"B3 child wrote RELATIVE path into the managed worktree",
	);
	ok(
		!sh("test -f probe.txt && echo present", `${FIXTURE}/work/producer`).includes("present") &&
			!sh("test -f probe.txt && echo present", B_SRC).includes("present"),
		"B3 rooted write did not land in the source checkout or sibling repos",
	);
	const probe = ((globalThis as Record<string, unknown>).__BRIDGE_PROBE__ ?? []) as Array<any>;
	const sessionStart = probe.find((p) => p.kind === "session_start");
	ok(Boolean(sessionStart), `child session_start observed (events: ${probe.map((p) => p.kind).join(",") || "none"})`);
	ok(sessionStart?.cwd === WORKSPACE_B, `B9 child SessionManager rooted at the workspace (got ${sessionStart?.cwd})`);
	const childTools = (sessionStart?.tools ?? []) as string[];
	ok(!childTools.includes("workspace_agent"), "B8 workspace_agent removed from child active tools");
	ok(childTools.includes("task"), "B8 stock task preserved in child active tools");
}

// ─── B6: root AGENTS.md fallback (workspace C has no .omp/AGENTS.md) ────
section("B6 root AGENTS.md fallback");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	let calls = 0;
	const handler = (context: unknown): unknown => {
		calls++;
		if (calls < 2) return toolCall("bash", { command: "true" });
		const ctxText = JSON.stringify(context);
		const ag = ctxText.indexOf("AGENTS");
		return yieldCall({
			status: "done",
			summary: JSON.stringify({
				sawRootC: ctxText.includes("MARKER-ROOT-AGENTS-C"),
				ctxLen: ctxText.length,
				agenciesSnippet: ag === -1 ? "NO-AGENTS-TOKEN" : ctxText.slice(Math.max(0, ag - 60), ag + 80),
			}),
			verification: [],
			gaps: [],
		});
	};
	const out = await runBridge(scriptModel("mock-fallback", handler), {
		workspace: WORKSPACE_C,
		task: "Probe context fallback.",
	});
	console.log("B6 out:", JSON.stringify(out).slice(0, 400));
	const summary = JSON.parse(String((out.result as any)?.summary ?? "{}"));
	ok(summary.sawRootC === true, `B6 root AGENTS.md delivered as fallback (got ${JSON.stringify(summary)})`);
}

// ─── B10: per-invocation model propagation ──────────────────────────────
section("B10 per-invocation ctx.model");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	const makeYielder = (tag: string) => {
		let calls = 0;
		return (context: unknown): unknown => {
			calls++;
			if (calls === 1) return toolCall("bash", { command: "true" });
			const ctxText = JSON.stringify(context);
			return yieldCall({
				status: "done",
				summary: JSON.stringify({ tag, sawSelf: ctxText.includes(tag) }),
				verification: [],
				gaps: [],
			});
		};
	};
	const modelA = scriptModel("mock-owner-a", makeYielder("owner-a-marker"));
	const modelB = scriptModel("mock-owner-b", makeYielder("owner-b-marker"));
	const outA = await runBridge(modelA, { workspace: WORKSPACE_B, task: `first invocation owner-a-marker` });
	const outB = await runBridge(modelB, { workspace: WORKSPACE_C, task: `second invocation owner-b-marker` });
	const probe = ((globalThis as Record<string, unknown>).__BRIDGE_PROBE__ ?? []) as Array<any>;
	const starts = probe.filter((p) => p.kind === "session_start");
	ok(
		outA.status === "done" && outB.status === "done",
		`both per-invocation runs completed (${outA.status}/${outB.status})`,
	);
	ok(
		starts.length === 2 && starts[0]?.modelId === "mock-owner-a" && starts[1]?.modelId === "mock-owner-b",
		`each RepoOwner received its own invocation model (got ${JSON.stringify(starts.map((s) => s.modelId))})`,
	);
}

// ─── B11: parallel RepoOwners ───────────────────────────────────────────
section("B11 parallel RepoOwners");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	const makeOwner = (label: string, marker: string) => {
		let calls = 0;
		return (context: unknown): unknown => {
			calls++;
			if (calls === 1) return toolCall("bash", { command: `printf '${label}' > owner.txt` });
			const ctxText = JSON.stringify(context);
			return yieldCall({
				status: "done",
				summary: JSON.stringify({ label, sawSelf: ctxText.includes(marker) }),
				verification: [{ check: `owner-${label}`, result: "pass" }],
				gaps: [],
			});
		};
	};
	const [outB, outC] = await Promise.all([
		runBridge(scriptModel("mock-owner-b", makeOwner("B", "MARKER-OMPDIR-AGENTS-B")), {
			workspace: WORKSPACE_B,
			task: "owner B",
		}),
		runBridge(scriptModel("mock-owner-c", makeOwner("C", "MARKER-ROOT-AGENTS-C")), {
			workspace: WORKSPACE_C,
			task: "owner C",
		}),
	]);
	const bFile = sh("cat owner.txt 2>/dev/null || echo MISSING", WORKSPACE_B);
	const cFile = sh("cat owner.txt 2>/dev/null || echo MISSING", WORKSPACE_C);
	ok(outB.status === "done" && outC.status === "done", `both parallel owners completed (${outB.status}/${outC.status})`);
	console.log("B11 B-file:", JSON.stringify(bFile), "C-file:", JSON.stringify(cFile));
	console.log("B11 B-out:", JSON.stringify(outB).slice(0, 260));
	console.log("B11 C-out:", JSON.stringify(outC).slice(0, 260));
	const starts = (((globalThis as Record<string, unknown>).__BRIDGE_PROBE__ ?? []) as Array<any>).filter(
		(p) => p.kind === "session_start",
	);
	ok(
		starts.length === 2 &&
			starts.some((s) => s.cwd === WORKSPACE_B) &&
			starts.some((s) => s.cwd === WORKSPACE_C),
		`two child sessions rooted in their own workspaces, no registry collision (got ${JSON.stringify(starts.map((s) => s.cwd))})`,
	);
	ok(bFile === "B" && cFile === "C", `each worktree holds only its own marker file (B=${JSON.stringify(bFile)}, C=${JSON.stringify(cFile)})`);
}

// ─── B12: failure isolation between concurrent owners ───────────────────
section("B12 failure isolation");
{
	(globalThis as Record<string, unknown>).__BRIDGE_PROBE__ = [];
	const sleeper = scriptModel("mock-sleeper", () => toolCall("bash", { command: "sleep 30" }));
	const finisherCalls = { n: 0 };
	const finisher = scriptModel("mock-finisher", () => {
		finisherCalls.n++;
		if (finisherCalls.n === 1) return toolCall("bash", { command: "printf done > finisher.txt" });
		return yieldCall({
			status: "done",
			summary: "finisher completed while sibling aborted",
			verification: [],
			gaps: [],
		});
	});
	const [slow, fast] = await Promise.all([
		runBridge(sleeper, { workspace: WORKSPACE_B, task: "sleep forever", timeout_ms: 2500 }),
		runBridge(finisher, { workspace: WORKSPACE_C, task: "finish quickly" }),
	]);
	ok(fast.status === "done", `concurrent healthy owner completed (${fast.status})`);
	ok(
		(slow.status === "partial" || slow.status === "blocked") && slow.child_may_have_mutated_repo === true,
		`aborted sibling reported partial/blocked without affecting the other (got ${slow.status})`,
	);
	ok(sh("test -f finisher.txt && cat finisher.txt", WORKSPACE_C) === "done", "healthy owner's file intact");
}

// ─── B13: no structured yield → blocked, no fallback ────────────────────
section("B13 no-yield classification");
{
	const model = scriptModel("mock-noyield", () => mockResponse(["still working"], "stop"));
	const out = await runBridge(model, {
		workspace: WORKSPACE_B,
		task: "Work but never yield.",
	});
	ok(
		out.status === "blocked" &&
			out.dispatched === true &&
			out.child_may_have_mutated_repo === true,
		`no-yield run is blocked with mutation warning and no fallback (got ${JSON.stringify(out).slice(0, 300)})`,
	);
}

// ─── B14: deadline aborts the child and returns partial ─────────────────
section("B14 deadline");
{
	const model = scriptModel("mock-sleeper2", () => toolCall("bash", { command: "sleep 30" }));
	const started = Date.now();
	const out = await runBridge(model, {
		workspace: WORKSPACE_B,
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
