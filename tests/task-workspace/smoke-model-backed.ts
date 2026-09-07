/**
 * Model-backed smoke for the workspace_agent bridge — OPT-IN.
 *
 * Run with TW_MODEL_SMOKE=1 after build-fixture.sh. Uses the REAL installed
 * OMP configuration and a REAL model — the real rooted-session acceptance
 * probe. Not part of the deterministic suites; costs a handful of model calls.
 *
 * Allowed providers: cloudru, zai, openai-codex ONLY (the providers actually
 * configured for this workflow). OpenRouter is explicitly rejected. The
 * requested model (TW_SMOKE_MODEL, default "zai/glm-5.3-flash") must resolve
 * with configured auth; on a provider/auth failure the smoke retries other
 * authenticated models from the allowed set before giving up.
 *
 * The cloudru provider comes from the installed pi-cloudru-provider plugin
 * (~/.omp/plugins/node_modules/pi-cloudru-provider) and is registered into the
 * standalone ModelRegistry the same way the plugin registers it at runtime.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

if (process.env.TW_MODEL_SMOKE !== "1") {
	console.error("Opt-in only: run with TW_MODEL_SMOKE=1 after build-fixture.sh");
	process.exit(2);
}

const ALLOWED_PROVIDERS: Record<string, true> = {
	cloudru: true,
	zai: true,
	"openai-codex": true,
};
const DEFAULT_MODEL = "zai/glm-5.3-flash";

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/var/tmp/omp-taskws";
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

// ─── real model: allowed providers only, explicit openrouter rejection ──
const authStorage = await AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

// Register the installed cloudru plugin's provider into the standalone
// registry (the plugin ships baseUrl/fallback models and reads
// CLOUDRU_API_KEY from the environment at runtime).
const CLOUDRU_PLUGIN =
	process.env.TW_CLOUDRU_PLUGIN ??
	path.join(String(process.env.HOME) || "/nonexistent", ".omp/plugins/node_modules/pi-cloudru-provider");
try {
	const plugin = await import(path.join(CLOUDRU_PLUGIN, "extensions", "cloudru-provider.ts"));
	const captured: Array<[string, unknown]> = [];
	const shim: Record<string, unknown> = new Proxy(
		{},
		{
			get: (_target, prop) => {
				if (prop === "registerProvider") {
					return (name: string, cfg: unknown) => {
						captured.push([name, cfg]);
					};
				}
				return () => undefined;
			},
		},
	);
	(plugin as { default: (pi: unknown) => void }).default(shim);
	for (const [name, cfg] of captured) {
		(modelRegistry as unknown as { registerProvider: (n: string, c: unknown) => void }).registerProvider(name, cfg);
	}
	console.log(`registered plugin providers: ${captured.map(([n]) => n).join(", ") || "(none)"}`);
} catch (e) {
	console.log(`cloudru plugin not registered: ${(e as Error).message}`);
}

const requested = process.env.TW_SMOKE_MODEL ?? DEFAULT_MODEL;
const requestedProvider = requested.split("/")[0];
if (requestedProvider === "openrouter") {
	console.error(
		"Rejected: openrouter/* models are not allowed for this workflow (allowed: cloudru, zai, openai-codex).",
	);
	process.exit(2);
}
if (ALLOWED_PROVIDERS[requestedProvider] !== true) {
	console.error(
		`Rejected: provider "${requestedProvider}" is outside the allowed set (cloudru, zai, openai-codex).`,
	);
	process.exit(2);
}

interface ModelSpec {
	provider: string;
	id: string;
}
function parseModelId(spec: string): ModelSpec | undefined {
	const [provider, ...rest] = spec.split("/");
	if (!provider || rest.length === 0) return undefined;
	return { provider, id: rest.join("/") };
}

// ─── workspace_agent under test ─────────────────────────────────────────
const tools = new Map<string, any>();
const pi: any = {
	registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t),
	on: () => {},
	typebox: omptype,
	pi: SDK,
};
const waMod = await import(path.join(EXTENSIONS_DIR, "workspace-agent.ts"));
waMod.default(pi);

const WORKSPACE_BASENAME = WORKSPACE.split("/").pop() ?? "";
const SMOKE_TASK = [
	"You are the repo owner for a smoke probe. Work with relative paths only.",
	"1. Create a file named smoke-probe.txt in the repository root containing exactly: rooted-smoke",
	"2. Your project context contains an AGENTS.md marker line: report its exact text in your final summary.",
	"3. Using the stock task tool, spawn one helper subagent — prefer launching it as a background (async) job. The helper must run pwd and must NOT touch anything outside this repository.",
	"4. Once the helper result has arrived, finish: call the yield tool with the envelope {\"status\": \"done\", \"summary\": <one line that includes (a) the exact marker text from step 2 and (b) the helper's reported directory basename>, \"verification\": [{\"check\": \"smoke-probe.txt exists\", \"result\": \"pass\"}], \"gaps\": []}.",
].join(" ");

async function runSmoke(model: unknown): Promise<any> {
	const tool = tools.get("workspace_agent");
	const res = (await tool.execute(
		"probe",
		{
			workspace: WORKSPACE,
			task: SMOKE_TASK,
			timeout_ms: 420000,
		},
		undefined,
		undefined,
		{ cwd: FIXTURE, model, modelRegistry },
	)) as { content: Array<{ text?: string }> };
	return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}");
}

// Preferred model first (if resolvable); on provider/auth failure retry other
// authenticated models from the allowed set (never openrouter).
type ModelLike = { provider: string; id: string };
const attempts: ModelLike[] = [];
const requestedSpec = parseModelId(requested);
if (requestedSpec) {
	const primary = modelRegistry.find(requestedSpec.provider, requestedSpec.id);
	if (primary && modelRegistry.hasConfiguredAuth(primary)) attempts.push(requestedSpec);
}
for (const m of modelRegistry.getAvailable()) {
	if (attempts.length >= 3) break;
	if (ALLOWED_PROVIDERS[m.provider] !== true) continue;
	if (!modelRegistry.hasConfiguredAuth(m)) continue;
	if (attempts.some((a) => a.provider === m.provider && a.id === m.id)) continue;
	attempts.push({ provider: m.provider, id: m.id });
}
if (attempts.length === 0) {
	const all = modelRegistry
		.getAvailable()
		.map((m) => `${m.provider}/${m.id}`)
		.slice(0, 12);
	console.error(
		"No allowed-provider model (cloudru, zai, openai-codex) is available with configured auth.",
		`Authenticated candidates outside the allowed set: ${all.join(", ") || "none"}`,
	);
	process.exit(1);
}

let out: any;
let used: ModelLike | undefined;
for (const spec of attempts) {
	console.log(`smoke model attempt: ${spec.provider}/${spec.id}`);
	const m = modelRegistry.find(spec.provider, spec.id);
	if (!m) continue;
	out = await runSmoke(m);
	used = spec;
	const reason = String(out.reason ?? "");
	const providerIssue =
		out.status === "blocked" && /model error|401|403|auth|credential|api/i.test(reason);
	if (out.status === "done" || !providerIssue) break;
	console.log(`attempt failed (provider/auth): ${reason.slice(0, 200)}`);
}
console.log("bridge result:", JSON.stringify(out).slice(0, 600));
console.log(`used model: ${used ? `${used.provider}/${used.id}` : "?"}`);

const summaryText = String((out.result as Record<string, unknown> | undefined)?.summary ?? "");
ok(out.status === "done" && out.dispatched === true, `smoke owner completed (status ${out.status})`);
ok(
	Boolean(out.result) && (out.result as Record<string, unknown>).status === "done",
	"structured envelope received with done",
);
ok(
	summaryText.includes("AGENTS-SMOKE-MARKER"),
	"D real model saw the B workspace project context marker",
);
ok(
	summaryText.includes(WORKSPACE_BASENAME),
	`B real nested stock task helper rooted at the workspace (expected basename ${WORKSPACE_BASENAME})`,
);
ok(
	sh("test -f smoke-probe.txt && cat smoke-probe.txt", WORKSPACE) === "rooted-smoke",
	"A REAL model wrote RELATIVE path into the managed worktree",
);
ok(
	!sh("test -f smoke-probe.txt && echo present", SRC).includes("present"),
	"A probe file did not land in the source checkout",
);

console.log("\nmodel-backed smoke complete");
