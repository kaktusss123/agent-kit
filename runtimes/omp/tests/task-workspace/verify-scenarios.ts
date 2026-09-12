/**
 * Deterministic V-scenarios for the task-workspace runtime extension.
 * Imports the extension straight from the repo working tree (override with
 * TW_EXTENSIONS_DIR) with a mock `pi` — no OMP runtime, no model, no provider.
 *
 * Coverage: workspace lifecycle (create/reuse/remote-only/lanes), fetch
 * semantics (fail closed, attached tracking branch, no stale refs), status
 * identity (workspace key, per-repo branches), mutation guard basics, commit
 * safety, source dirt isolation.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/var/tmp/omp-taskws";
const EXTENSIONS_DIR =
	process.env.TW_EXTENSIONS_DIR ??
	path.join(import.meta.dir, "..", "..", "dot_omp", "private_agent", "extensions");
process.env.AGENT_TASK_ROOT = `${FIXTURE}/tasks`;
const RUN_MARKER = `${FIXTURE}/.tw-run-complete`;
if (await fs.stat(RUN_MARKER).then(() => true).catch(() => false)) {
	console.error("Fixture already consumed — re-run build-fixture.sh before this suite.");
	process.exit(2);
}
const TASK_ROOT = `${FIXTURE}/tasks`;

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
}
type Json = Record<string, unknown>;

const tools = new Map<string, any>();
const guards: Array<(e: any, ctx: any) => any> = [];
const omptype = await import(
	process.env.TW_OMPTYPE_PATH ??
		"/Users/vekomarnitskiy/projects/devtools/oh-my-pi/packages/omptype/src/typebox.ts"
);
const pi: any = {
	registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t),
	on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
		if (event === "tool_call") guards.push(handler);
	},
	typebox: omptype,
};
const mod = await import(path.join(EXTENSIONS_DIR, "task-workspace.ts"));
mod.default(pi);

const driverCwd = FIXTURE;
async function call(name: string, params: Json): Promise<Json> {
	const tool = tools.get(name) as { execute: Function };
	if (!tool) throw new Error(`missing tool ${name}`);
	const res = (await tool.execute("probe", params, undefined, undefined, { cwd: driverCwd })) as ToolResult;
	const text = res.content.find((c) => c.type === "text")?.text ?? "";
	try {
		return JSON.parse(text) as Json;
	} catch {
		return { unparsed: text };
	}
}
function guard(toolName: string, input: Json): { blocked: boolean; reason?: string } {
	for (const h of guards) {
		const r = h({ type: "tool_call", toolCallId: "p", toolName, input }, { cwd: driverCwd });
		if (r?.block) return { blocked: true, reason: String(r.reason) };
	}
	return { blocked: false };
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

const PRODUCER = `${FIXTURE}/work/producer`;
const CONSUMER = `${FIXTURE}/work/consumer`;

// --- V1: fresh ticketed task -------------------------------------------------
section("V1 fresh task");
const r1a = await call("ensure_task_repo", {
	branch: "feat/EVODP-60001_multi",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
ok(r1a.status === "created", `producer created from explicit base (got ${JSON.stringify(r1a)})`);
ok(r1a.branchSource === "base" && r1a.upstream === null, "created reports branchSource=base, upstream=null");
const producerRoot = sh("pwd -P", PRODUCER);
const canonicalInput = (r1a.inputRepo ?? {}) as Json;
ok(
	canonicalInput.inputPath === PRODUCER &&
		canonicalInput.gitRoot === producerRoot &&
		canonicalInput.classification === "PRIMARY_CHECKOUT" &&
		canonicalInput.branch === "main" &&
		typeof canonicalInput.headSha === "string",
	"canonical result identifies the exact primary input checkout",
);
const r1default = await call("ensure_task_repo", {
	branch: "feat/EVODP-60004_default_base",
	source_path: PRODUCER,
});
ok(
	r1default.status === "base_selection_required" &&
		r1default.remoteDefault === "main" &&
		r1default.developExists === true,
	"producer requires explicit base when develop coexists with non-develop remote default",
);
const noDefaultRoot = `${FIXTURE}/work/no-default`;
sh(`git init -q --bare ${FIXTURE}/remotes/no-default.git`, FIXTURE);
sh(`git init -q ${noDefaultRoot}`, FIXTURE);
sh(
	`git -C ${noDefaultRoot} remote add origin ${FIXTURE}/remotes/no-default.git`,
	FIXTURE,
);
const noDefaultRemote = sh("git remote get-url origin", noDefaultRoot);
ok(
	noDefaultRemote === `${FIXTURE}/remotes/no-default.git`,
	"no-default fixture has the expected origin remote",
);
const noDefault = await call("ensure_task_repo", {
	branch: "feat/EVODP-60005_no_default",
	source_path: noDefaultRoot,
});
const noDefaultTarget = `${TASK_ROOT}/feat_EVODP-60005_no_default/no-default`;
const noDefaultWorktreeExists = await fs
	.stat(noDefaultTarget)
	.then(() => true)
	.catch(() => false);
ok(
	noDefault.status === "error" && !noDefaultWorktreeExists,
	"missing remote default fails closed instead of guessing a base",
);
const r1b = await call("ensure_task_repo", {
	branch: "feat/EVODP-60001_multi",
	source_path: CONSUMER,
});
ok(
	r1b.status === "created" && String((r1b.base as Json | undefined)?.ref).includes("develop"),
	`consumer uses its deterministic remote default (got ${r1b.status}, base ${JSON.stringify(r1b.base)})`,
);
const ws1 = `${TASK_ROOT}/feat_EVODP-60001_multi`;
const managedProducerPath = sh("pwd -P", `${ws1}/producer`);
const wsGit = await fs
	.stat(`${ws1}/.git`)
	.then((s) => s.isDirectory())
	.catch(() => false);
ok(wsGit === false, "workspace root is not a git repo (no .git dir)");

// --- V2: continuation + remote-only branch materializes ATTACHED ------------
section("V2 continuation and remote-only branch");
const r2 = await call("ensure_task_repo", {
	branch: "feat/EVODP-60001_multi",
	source_path: PRODUCER,
});
ok(r2.status === "reused", `reused managed worktree (got ${r2.status})`);
ok(r2.branchSource === "local", "reused reports branchSource=local");
const r2c = await call("ensure_task_repo", {
	branch: "feat/EVODP-70001_remote_only",
	source_path: PRODUCER,
});
ok(r2c.status === "created_from_remote", `remote-only branch materialized (got ${r2c.status})`);
ok(
	sh("git branch --show-current", `${TASK_ROOT}/feat_EVODP-70001_remote_only/producer`) ===
		"feat/EVODP-70001_remote_only",
	"remote-only worktree is an attached local branch, not detached HEAD",
);
ok(
	r2c.branchSource === "remote" &&
		r2c.upstream === "origin/feat/EVODP-70001_remote_only" &&
		(r2c.inputRepo as Json)?.inputPath === PRODUCER,
	`created_from_remote reports source identity and upstream (got ${JSON.stringify({ inputRepo: r2c.inputRepo, upstream: r2c.upstream })})`,
);

// --- V3: status identity is the workspace key, not a repo branch ------------
section("V3 workspace status identity");
const st = await call("task_status", {});
const spaces = (st.taskWorkspaces ?? []) as Array<Json>;
const multi = spaces.find((s) => s.key === "feat_EVODP-60001_multi");
ok(multi !== undefined, `workspace keyed by directory basename (keys: ${spaces.map((s) => s.key).join(", ")})`);
ok(multi !== undefined && !("branch" in multi), "workspace entry carries no lossy branch field");
const canonicalRepo = (multi?.repos as Array<Json> | undefined)?.find(
	(r) => r.name === "producer",
);
ok(
	canonicalRepo?.kind === "canonical" &&
		canonicalRepo?.slot === null &&
		canonicalRepo?.path === managedProducerPath &&
		canonicalRepo?.classification === "MANAGED_TASK_WORKTREE" &&
		typeof canonicalRepo?.headSha === "string" &&
		canonicalRepo?.dirty !== undefined,
	"task_status exposes canonical worktree topology and dirty facts",
);
ok(
	multi !== undefined &&
	(multi.repos as Array<Json>).length === 2 &&
		(multi.repos as Array<Json>).every((r) => r.branch === "feat/EVODP-60001_multi"),
	"branches reported per repo",
);
const remoteOnly = spaces.find((s) => s.key === "feat_EVODP-70001_remote_only");
ok(
	remoteOnly !== undefined &&
	(remoteOnly.repos as Array<Json>)[0]?.kind === "canonical" &&
	(remoteOnly.repos as Array<Json>)[0]?.slot === null &&
	(remoteOnly.repos as Array<Json>)[0]?.branch === "feat/EVODP-70001_remote_only",
	"task_status marks a single-repo workspace as canonical",
);

// --- V4: dirty source untouched ---------------------------------------------
section("V4 dirty source");
ok(sh("test -f WIP-PRODUCER.txt && echo yes", PRODUCER) === "yes", "producer WIP file still present");
await fs.writeFile(`${ws1}/producer/source-work.txt`, "managed input dirt\n");
const managedInputResult = await call("ensure_task_repo", {
	branch: "feat/EVODP-60001_multi",
	source_path: `${ws1}/producer`,
});
const managedInput = (managedInputResult.inputRepo ?? {}) as Json;
const managedDirty = (managedInput.dirty ?? {}) as Json;
ok(
	managedInput.inputPath === `${ws1}/producer` &&
		managedInput.gitRoot === managedProducerPath &&
		managedInput.classification === "MANAGED_TASK_WORKTREE" &&
		managedInput.branch === "feat/EVODP-60001_multi" &&
		(managedDirty.unstaged as string[]).includes("source-work.txt"),
	"dirty managed source_path is explicitly identified as a managed worktree",
);
await fs.rm(`${ws1}/producer/source-work.txt`);
const dirty = await call("ensure_task_repo", {
	branch: "feat/EVODP-60001_multi",
	source_path: PRODUCER,
});
const inputDirty = (dirty.inputRepo ?? {}) as Json;
const dirtyInfo = (inputDirty.dirty ?? {}) as Json;
ok(
	inputDirty.inputPath === PRODUCER &&
		inputDirty.gitRoot === producerRoot &&
		inputDirty.classification === "PRIMARY_CHECKOUT" &&
		(dirtyInfo.unstaged as string[]).includes("WIP-PRODUCER.txt"),
	`primary input dirt is tied to inputRepo (got ${JSON.stringify(dirtyInfo)})`,
);
ok(
	sh("test ! -f WIP-PRODUCER.txt && echo clean", `${ws1}/producer`) === "clean",
	"task worktree does not inherit source dirt",
);

// --- V5: branch in use --------------------------------------------------------
section("V5 branch in use");
const r5 = await call("ensure_task_repo", {
	branch: "feat/EVODP-80001_manual",
	source_path: PRODUCER,
});
ok(r5.status === "branch_in_use", `manual-worktree branch not detached (got ${r5.status})`);
ok(
	sh("git branch --show-current", `${FIXTURE}/work/producer-manual-wt`) === "feat/EVODP-80001_manual",
	"manual worktree still on its branch",
);

// --- V6: mutation guard -------------------------------------------------------
section("V6 mutation guard");
const g1 = guard("write", { path: `${PRODUCER}/README.md`, content: "x" });
ok(g1.blocked === true, `write to primary blocked when task workspace exists (${g1.reason ?? ""})`);
ok(
	g1.reason !== undefined && g1.reason.includes(`${ws1}/producer`),
	"blocked write hints the same-repo managed worktree",
);
const g2 = guard("write", { path: `${ws1}/producer/README.md`, content: "x" });
ok(g2.blocked === false, "write to managed task worktree allowed");
const g3 = guard("write", { path: `${FIXTURE}/work/producer-manual-wt/README.md`, content: "x" });
ok(g3.blocked === false, "write to manual linked worktree allowed");
const g4 = guard("write", { path: "/tmp/outside-git.txt", content: "x" });
ok(g4.blocked === false, "write outside git allowed");
const g5 = guard("bash", { command: `git -C ${PRODUCER} commit -m x` });
ok(g5.blocked === true, "mutating git bash command on primary blocked");
const g6 = guard("bash", { command: `git -C ${PRODUCER} log --oneline -1` });
ok(g6.blocked === false, "read-only git bash command allowed");

// --- V7: multi-repo workspace artifacts --------------------------------------
section("V7 multi-repo workspace artifacts");
await fs.writeFile(`${ws1}/SPEC.md`, "# Cross-repo spec\n");
const st7 = await call("task_status", {});
const ws7 = ((st7.taskWorkspaces ?? []) as Array<Json>).find((s) => s.key === "feat_EVODP-60001_multi");
const artifacts = (ws7?.artifacts ?? []) as string[];
ok(artifacts.includes("SPEC.md"), `SPEC.md visible in task workspace (${JSON.stringify(artifacts)})`);

// --- V8: fetch failure fails closed ------------------------------------------
section("V8 fetch failure fails closed");
const STALE = `${FIXTURE}/work/stalefail`;
sh("git clone -q ../remotes/producer.git stalefail", `${FIXTURE}/work`);
sh("git config user.email fixture@local && git config user.name fixture", STALE);
// Break the remote so the required fetch fails, then ask for a branch that
// exists neither locally nor in the (now unreachable) refreshed refs.
sh("git remote set-url origin ../remotes/nonexistent.git", STALE);
const r8 = await call("ensure_task_repo", {
	branch: "feat/EVODP-90001_stale",
	source_path: STALE,
});
ok(
	r8.status === "error" && String(r8.message).toLowerCase().includes("fetch"),
	`fetch failure fails closed (got ${JSON.stringify(r8)})`,
);
ok(
	!(await fs
		.stat(`${TASK_ROOT}/feat_EVODP-90001_stale`)
		.then(() => true)
		.catch(() => false)),
	"no managed worktree created from stale refs",
);

// --- V9: commit safety --------------------------------------------------------
section("V9 commit safety");
const cFile = `${ws1}/producer/feature.txt`;
await fs.writeFile(cFile, "task change\n");
await fs.writeFile(`${ws1}/producer/.env.local`, "K=V\n");
const c1 = await call("checkpoint_commit", {
	repo: `${ws1}/producer`,
	paths: ["feature.txt", ".env.local"],
	message: "feat: task change",
});
ok(c1.status === "secret_path_rejected", `secret path rejected (got ${c1.status})`);
const c2 = await call("checkpoint_commit", {
	repo: `${ws1}/producer`,
	paths: ["feature.txt"],
	message: "feat: task change",
});
ok(c2.status === "committed", `exact-path commit in worktree (got ${c2.status})`);
ok(
	sh("git status --porcelain", `${ws1}/producer`).includes(".env.local"),
	"secret left unstaged",
);
const c3 = await call("checkpoint_commit", {
	repo: PRODUCER,
	paths: ["README.md"],
	message: "feat: primary change",
});
ok(c3.status === "primary_commit_blocked", `primary commit blocked by default (got ${c3.status})`);
await fs.appendFile(`${PRODUCER}/README.md`, "docs note for manual commit\n");
const c4 = await call("checkpoint_commit", {
	repo: PRODUCER,
	paths: ["README.md"],
	message: "docs: manual primary update",
	allow_primary: true,
});
ok(c4.status === "committed", `explicit manual primary commit allowed (got ${c4.status})`);

// --- V10: read-only no-task ---------------------------------------------------
section("V10 read-only no-task");
const before = (await fs.readdir(TASK_ROOT)).sort();
await call("task_status", { path: PRODUCER });
const after = (await fs.readdir(TASK_ROOT)).sort();
ok(JSON.stringify(before) === JSON.stringify(after), "task_status creates no workspaces");

console.log(`\nscenario run complete on ${path.join(EXTENSIONS_DIR, "task-workspace.ts")}`);
await fs.writeFile(RUN_MARKER, new Date().toISOString() + "\n");
