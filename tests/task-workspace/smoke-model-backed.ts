/**
 * Model-backed smoke for the workspace_agent bridge — OPT-IN.
 *
 * Run with TW_MODEL_SMOKE=1 after build-fixture.sh. Uses the REAL installed
 * OMP configuration and a REAL model — the "at least one real rooted-session
 * run on stock OMP" acceptance probe. Not part of the deterministic suites;
 * costs a handful of model calls.
 *
 * The smoke pins a KNOWN-WORKING provider/id (TW_SMOKE_MODEL, default
 * "zai/glm-5.3-flash") instead of trusting registry order: configured-but-
 * stale keys exist on real machines. Missing model/auth fails the smoke.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

if (process.env.TW_MODEL_SMOKE !== "1") {
	console.error("Opt-in only: run with TW_MODEL_SMOKE=1 after build-fixture.sh");
	process.exit(2);
}

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/tmp/omp-taskws";
const EXTENSIONS_DIR =
	process.env.TW_EXTENSIONS_DIR ??
	path.join(import.meta.dir, "..", "..", "dot_omp", "private_agent", "extensions");
const OMP_SRC =
	process.env.TW_OMP_SRC ??
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/coding-agent/src";
process.env.OMP_TASK_ROOT = `${FIXTURE}/smoke-tasks`;

const SDK = await import(`${OMP_SRC}/index.ts`);
const omptype = await import(
	"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/omptype/src/typebox.ts"
);
const { AuthStorage } = await import(`${OMP_SRC}/session/auth-storage.ts`);
const { ModelRegistry } = await import(`${OMP_SRC}/config/model-registry.ts`);

function ok(cond: boolean, label: string): void {
	console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
	if (!cond) process.exitCode = 1;
}
function sh(cmd: string, dir: string): string {
	const out = Bun.spawnSync(["bash", "-c", cmd], { cwd: dir });
	return out.stdout.toString().trim();
}

// ─── fixture: disposable source repo + managed worktree ─────────────────
const SRC = `${FIXTURE}/work/smoke-src`;
await fs.mkdir(`${SRC}/.omp/extensions`, { recursive: true });
await fs.writeFile(`${SRC}/AGENTS.md`, "AGENTS-SMOKE-MARKER: smoke workspace project context\n");
await fs.writeFile(`${SRC}/README.md`, "# smoke source\n");
sh("git init -q --bare -b main ../remotes/smoke.git", SRC);
sh("git init -q -b main .", SRC);
sh("git config user.email fixture@local && git config user.name fixture", SRC);
sh("git remote add origin ../remotes/smoke.git", SRC);
sh("git add -A && git commit -qm 'smoke baseline'", SRC);
sh("git push -q origin main", SRC);

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
	const res = (await tool.execute("probe", params, undefined, undefined, { cwd: FIXTURE })) as {
		content: Array<{ text?: string }>;
	};
	return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
}
const ensured = await twCall("ensure_task_repo", {
	branch: "feat/SMOKE-1",
	source_path: SRC,
	base_ref: "main",
});
if (ensured.status !== "created" && ensured.status !== "reused") {
	console.error(`ensure_task_repo failed: ${JSON.stringify(ensured)}`);
	process.exit(1);
}
const WORKSPACE = String(ensured.worktree);

// ─── real model: exact known-working provider/id, honest failure ────────
const authStorage = await AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const requested = (process.env.TW_SMOKE_MODEL ?? "zai/glm-5.3-flash").split("/");
const model = modelRegistry.find(requested[0], requested.slice(1).join("/"));
if (!model || !modelRegistry.hasConfiguredAuth(model)) {
	const candidates = modelRegistry
		.getAvailable()
		.filter((m) => modelRegistry.hasConfiguredAuth(m))
		.map((m) => `${m.provider}/${m.id}`);
	console.error(
		`Requested smoke model "${process.env.TW_SMOKE_MODEL ?? "zai/glm-5.3-flash"}" is not available with configured auth.`,
		`Authenticated candidates: ${candidates.join(", ") || "none"}`,
	);
	process.exit(1);
}
console.log(`smoke model: ${model.provider}/${model.id}`);

// ─── workspace_agent under test ─────────────────────────────────────────
const tools = new Map<string, any>();
const eventHandlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
const pi: any = {
	registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t),
	on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
		eventHandlers.set(event, handler);
	},
	typebox: omptype,
	pi: SDK,
};
const waMod = await import(path.join(EXTENSIONS_DIR, "workspace-agent.ts"));
waMod.default(pi);
eventHandlers.get("turn_start")?.({ type: "turn_start" }, { model, modelRegistry });

const tool = tools.get("workspace_agent");
const res = (await tool.execute(
	"probe",
	{
		workspace: WORKSPACE,
		task: [
			"You are the repo owner for a smoke probe.",
			"1. Create a file named smoke-probe.txt in the repository root containing exactly: rooted-smoke",
			"2. Read it back to confirm.",
			'3. Finish by calling the yield tool with the envelope {"status": "done", "summary": <one line>, "verification": [{"check": "smoke-probe.txt exists", "result": "pass"}], "gaps": []}.',
		].join(" "),
		timeout_ms: 300000,
	},
	undefined,
	undefined,
	{ cwd: FIXTURE },
)) as { content: Array<{ text?: string }> };
const out = JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
console.log("bridge result:", JSON.stringify(out).slice(0, 400));

ok(out.status === "done" && out.dispatched === true, `smoke owner completed (status ${out.status})`);
ok(
	Boolean(out.result) && (out.result as Record<string, unknown>).status === "done",
	"structured envelope received with done",
);
ok(
	sh("test -f smoke-probe.txt && cat smoke-probe.txt", WORKSPACE) === "rooted-smoke",
	"REAL model wrote RELATIVE path into the managed worktree",
);
ok(
	!sh("test -f smoke-probe.txt && echo present", SRC).includes("present"),
	"probe file did not land in the source checkout",
);

console.log("\nmodel-backed smoke complete");
