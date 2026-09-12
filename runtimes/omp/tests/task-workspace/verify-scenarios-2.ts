/**
 * Deterministic deep-guard scenarios for the task-workspace runtime extension:
 * URI targets, compound shell commands, raw --no-verify, same-repo worktree
 * hints, secondary lanes, and deferred-hook evidence bound to the staged tree.
 * Imports the extension from the repo working tree (TW_EXTENSIONS_DIR override)
 * with a mock `pi` — no OMP runtime, no model, no provider.
 */
import * as fs from "node:fs/promises";
import path from "node:path";

const FIXTURE = process.env.TW_FIXTURE_ROOT ?? "/var/tmp/omp-taskws";
const EXTENSIONS_DIR =
	process.env.TW_EXTENSIONS_DIR ??
	path.join(import.meta.dir, "..", "..", "dot_omp", "private_agent", "extensions");
process.env.AGENT_TASK_ROOT = `${FIXTURE}/tasks`;
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
function guard(toolName: string, input: Json, cwd = driverCwd): { blocked: boolean; reason?: string } {
	for (const h of guards) {
		const r = h({ type: "tool_call", toolCallId: "p", toolName, input }, { cwd });
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
const FAILED_STEP = "uv run pytest -k deferred_contract";

// --- setup: two managed workspaces over producer, one over consumer ----------
section("setup");
const r0 = await call("ensure_task_repo", {
	branch: "feat/EVODP-60002_uri",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
ok(r0.status === "created", `canonical created (got ${r0.status})`);
const ws = `${TASK_ROOT}/feat_EVODP-60002_uri`;
const r0b = await call("ensure_task_repo", {
	branch: "feat/EVODP-60003_second",
	source_path: PRODUCER,
	base_ref: "origin/main",
});
ok(r0b.status === "created", `second producer workspace created (got ${r0b.status})`);
const ws2 = `${TASK_ROOT}/feat_EVODP-60003_second`;
const r0c = await call("ensure_task_repo", {
	branch: "feat/EVODP-60002_uri",
	source_path: CONSUMER,
});
ok(r0c.status === "created", `consumer joined canonical (got ${r0c.status})`);

// --- S1: internal-URI targets are never filesystem paths --------------------
section("S1 URI guard");
ok(guard("write", { path: "local://report.md", content: "x" }).blocked === false, "write to local:// not classified as path");
ok(guard("bash", { command: "git -C local://repo commit -m x" }).blocked === false, "git -C local:// skipped by guard");
// --- S1b: temporary git repositories are exempt from routing guards ----------
section("S1b temporary git repositories");
const TEMP_REPOS = ["/tmp/omp-taskws-git-exempt", "/private/tmp/omp-taskws-git-exempt"];
for (const tempRepo of TEMP_REPOS) {
	await fs.rm(tempRepo, { recursive: true, force: true });
	await fs.mkdir(tempRepo, { recursive: true });
	sh("git init -q", tempRepo);
}
const t1 = guard("write", { path: `${TEMP_REPOS[0]}/.git/config`, content: "x" }, PRODUCER);
ok(t1.blocked === false, "writes inside /tmp git repositories are exempt");
const t2 = guard("bash", { command: `git -C ${TEMP_REPOS[0]} commit -m x` }, PRODUCER);
ok(t2.blocked === false, "mutating git in /tmp repositories is exempt");
const t3 = guard("bash", { command: `cd ${TEMP_REPOS[1]} && git commit -m x` }, PRODUCER);
ok(t3.blocked === false, "mutating git after cd into /private/tmp is exempt");
const t4 = guard("bash", { command: `cd ${TEMP_REPOS[0]} && git -C ${PRODUCER} commit -m x` }, PRODUCER);
ok(t4.blocked === true, "temporary cwd does not exempt an explicitly targeted primary checkout");
for (const tempRepo of TEMP_REPOS) {
	await fs.rm(tempRepo, { recursive: true, force: true });
}


// --- S2: compound commands cannot hide mutating git -------------------------
section("S2 compound mutation guard");
const c1 = guard("bash", { command: `git -C ${PRODUCER} status && git -C ${PRODUCER} commit -m x` });
ok(c1.blocked === true, "status && commit blocked (compound)");
const c2 = guard("bash", { command: `git -C ${PRODUCER} diff; git -C ${PRODUCER} add README.md` });
ok(c2.blocked === true, "diff ; add blocked (compound)");
const c3 = guard("bash", { command: "echo ok && git -C . reset" }, PRODUCER);
ok(c3.blocked === true, "echo && git reset blocked from primary cwd (compound)");
const c4 = guard("bash", { command: `git -C ${PRODUCER} status && git -C ${PRODUCER} diff` });
ok(c4.blocked === false, "read-only compound allowed");
const c5 = guard("bash", { command: `git -C ${PRODUCER} log | grep x` });
ok(c5.blocked === false, "piped read-only allowed");
const c6 = guard("bash", {
	command: `git -C ${CONSUMER} commit -m x && git -C ${PRODUCER} commit -m y`,
});
ok(c6.blocked === true, "any primary-target mutation in compound blocks the whole command");
const c7 = guard("bash", { command: `git -C ${ws}/producer commit -m x` });
ok(c7.blocked === false, "mutating git inside managed worktree allowed");
const c8 = guard("bash", {
	command: `git -C ${PRODUCER} worktree list && git -C ${PRODUCER} add x`,
});
ok(c8.blocked === true, "worktree list (read-only) does not mask following add");
const c9 = guard("bash", { command: `git -C ${ws}/producer commit -m "fix: git add bug"` });
ok(c9.blocked === false, "quoted argument mentioning git subcommand not re-parsed as invocation");

// --- S2b: form-aware branch, tag, ref, refresh, and push classification ------
section("S2b Git operation classes");
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --show-current` }).blocked === false,
	"branch --show-current is read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --list` }).blocked === false,
	"branch --list is read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch -a` }).blocked === false,
	"branch -a is read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch new-name` }).blocked === true,
	"branch name creation is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch -D old` }).blocked === true,
	"branch -D is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch -m old new` }).blocked === true,
	"branch -m is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --sort=refname -D foo` }).blocked === true,
	"branch attached read-only option does not mask -D mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag --sort=refname -d foo` }).blocked === true,
	"tag attached read-only option does not mask -d mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --sort refname --list` }).blocked === false,
	"branch separate read-only option value is consumed",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag --sort refname --list` }).blocked === false,
	"tag separate read-only option value is consumed",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --column -D foo` }).blocked === true,
	"branch --column does not mask -D mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag --column -d foo` }).blocked === true,
	"tag --column does not mask -d mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --column=always --list` }).blocked === false,
	"branch attached --column value remains read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag --column=always --list` }).blocked === false,
	"tag attached --column value remains read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag --list` }).blocked === false &&
		guard("bash", { command: `git -C ${PRODUCER} tag` }).blocked === false,
	"tag listing is read-only",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag v1` }).blocked === true,
	"tag creation is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} tag -d v1` }).blocked === true &&
		guard("bash", { command: `git -C ${PRODUCER} tag -f v1` }).blocked === true,
	"tag deletion and force are local mutations",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} update-ref refs/heads/x HEAD` }).blocked === true,
	"update-ref is a local ref mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch` }).blocked === false,
	"fetch is a safe refresh allowed from primary",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch origin main:refs/heads/foo` }).blocked === true,
	"fetch refspec targeting refs/heads is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch origin main:refs/remotes/origin/foo` }).blocked === true,
	"unknown fetch destination refspec fails closed",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch --refmap=refs/heads/main:refs/heads/foo origin main` }).blocked === true,
	"fetch attached --refmap targeting refs/heads is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch --refmap refs/heads/main:refs/heads/foo origin main` }).blocked === true,
	"fetch separate --refmap targeting refs/heads is a local mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch --stdin origin` }).blocked === true,
	"fetch --stdin is ambiguous because refspec content is unavailable",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch --prune origin` }).blocked === false,
	"fetch --prune remains a safe refresh",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch --prune-tags origin` }).blocked === true,
	"fetch --prune-tags is a local ref mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} fetch -P origin` }).blocked === true,
	"fetch -P is a local ref mutation",
);
const localOnlyTag = "local-only-refresh-tag";
sh(`git tag ${localOnlyTag}`, PRODUCER);
sh("git config fetch.pruneTags true", PRODUCER);
const refresh = await call("ensure_task_repo", {
	branch: "feat/EVODP-90001_refresh",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
const tagSurvives = sh(
	`git show-ref --verify --quiet refs/tags/${localOnlyTag} && echo present || echo missing`,
	PRODUCER,
);
ok(
	refresh.status === "created" && tagSurvives === "present",
	"ensure_task_repo refresh preserves local-only tags with fetch.pruneTags=true",
);
sh(`git tag -d ${localOnlyTag} >/dev/null 2>&1; git config --unset fetch.pruneTags`, PRODUCER);
ok(
	guard("bash", { command: `git -C ${PRODUCER} push` }).blocked === false,
	"push is an external side effect, not primary routing mutation",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --show-current && git -C ${PRODUCER} branch -D foo` }).blocked === true,
	"read-only branch followed by mutation blocks the compound command",
);
ok(
	guard("bash", { command: `git -C ${PRODUCER} branch --list && git -C ${PRODUCER} tag` }).blocked === false,
	"read-only branch and tag compound command remains allowed",
);


ok(
	guard("bash", { command: `git -C ${PRODUCER} worktree show` }).blocked === false,
	"worktree show is read-only",
);
// --- S3: raw --no-verify is policy-forbidden everywhere ---------------------
section("S3 raw --no-verify");
const n1 = guard("bash", { command: `git -C ${PRODUCER} commit --no-verify -m x` });
ok(n1.blocked === true, "commit --no-verify on primary blocked");
const n2 = guard("bash", { command: `git -C ${ws}/producer commit --no-verify -m x` });
ok(n2.blocked === true, "commit --no-verify blocked even in managed worktree");
const n3 = guard("bash", { command: `git -C ${ws}/producer commit -m "use --no-verify next time"` });
ok(n3.blocked === false, "--no-verify inside quoted message is not a bypass flag");
const n4 = guard("bash", { command: `git -C ${PRODUCER} commit -n -m x` });
ok(n4.blocked === true, "commit -n on primary is blocked as a hook bypass");
const n5 = guard("bash", { command: `git -C ${ws}/producer commit -n -m x` });
ok(n5.blocked === true, "commit -n blocked even in managed worktree");
const n6 = guard("bash", { command: `git -C ${PRODUCER} tag -n` });
ok(n6.blocked === false, "tag -n is not classified as a hook bypass");

// --- S4: blocked mutations hint worktrees of the SAME repository ------------
section("S4 same-repo worktree hints");
const h1 = guard("bash", { command: `git -C ${PRODUCER} commit -m x` });
ok(
	h1.blocked === true &&
		String(h1.reason).includes(`${ws}/producer`) &&
		String(h1.reason).includes(`${ws2}/producer`),
	"multi-candidate hint lists all managed worktrees of the repo",
);
ok(!String(h1.reason).includes(`${ws}/consumer`), "hint does not leak other repos' worktrees");
const h2 = guard("bash", { command: `git -C ${CONSUMER} commit -m x` });
ok(
	h2.blocked === true &&
		String(h2.reason).includes(`${ws}/consumer`) &&
		!String(h2.reason).includes(`${ws}/producer`),
	"single-candidate hint names exactly the one consumer worktree",
);
const STALE = `${FIXTURE}/work/stalefail`;
sh("git clone -q ../remotes/producer.git stalehint", `${FIXTURE}/work`);
const h3 = guard("write", { path: `${FIXTURE}/work/stalehint/README.md`, content: "x" });
ok(h3.blocked === false, "primary with no managed worktrees is not blocked and no path invented");

// --- S5: secondary lanes stay inside the canonical workspace ----------------
section("S5 secondary lanes");
const invalidSlot = await call("ensure_task_repo", {
	task: "feat/EVODP-60002_uri",
	slot: "qa__east",
	branch: "hotfix/EVODP-60008_invalid-slot",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
const invalidSlotPath = `${ws}/producer__qa__east`;
const invalidSlotExists = await fs
	.stat(invalidSlotPath)
	.then(() => true)
	.catch(() => false);
ok(
	invalidSlot.status === "error" && !invalidSlotExists,
	"slot containing __ is rejected before worktree creation",
);
const l1 = await call("ensure_task_repo", {
	task: "feat/EVODP-60002_uri",
	slot: "develop-backport",
	branch: "hotfix/EVODP-60002_uri",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
ok(l1.status === "created", `lane worktree created (got ${l1.status})`);
ok(
	sh("git branch --show-current", `${ws}/producer__develop-backport`) === "hotfix/EVODP-60002_uri",
	"lane worktree on its own branch inside the canonical workspace",
);
const st5 = await call("task_status", {});
const ws5 = ((st5.taskWorkspaces ?? []) as Array<Json>).find((s) => s.key === "feat_EVODP-60002_uri");
const repos5 = (ws5?.repos ?? []) as Array<Json>;
const laneRepo = repos5.find((r) => r.name === "producer__develop-backport");
const laneInput = (l1.inputRepo ?? {}) as Json;
ok(
	l1.kind === "lane" &&
		l1.slot === "develop-backport" &&
		laneInput.inputPath === PRODUCER &&
		laneInput.classification === "PRIMARY_CHECKOUT",
	"lane result identifies kind, slot, and its exact input checkout",
);
ok(
	laneRepo?.kind === "lane" &&
		laneRepo?.slot === "develop-backport" &&
		laneRepo?.path === sh("pwd -P", `${ws}/producer__develop-backport`) &&
		"upstream" in (laneRepo ?? {}) &&
		laneRepo?.dirty !== undefined,
	"task_status exposes lane slot, path, upstream, and dirty facts",
);
ok(
	(l1.base as Json)?.ref === "origin/develop" &&
		typeof (l1.base as Json)?.sha === "string",
	"lane result retains known explicit base provenance",
);
ok(
	repos5.some((r) => r.name === "producer__develop-backport") && repos5.length === 3,
	"lane listed as a repo of the same workspace (no second workspace)",
);
ok(
	((st5.taskWorkspaces ?? []) as Array<Json>).filter((s) => String(s.key).includes("EVODP-60002")).length === 1,
	"lane did not spawn a second task workspace",
);

const trickyRemote = `${FIXTURE}/remotes/foo__bar.git`;
const trickySource = `${FIXTURE}/work/foo__bar`;
sh(`git init -q --bare -b main ${trickyRemote}`, FIXTURE);
sh(`git init -q -b main ${trickySource}`, FIXTURE);
sh(`git -C ${trickySource} config user.email fixture@local`, FIXTURE);
sh(`git -C ${trickySource} config user.name fixture`, FIXTURE);
await fs.writeFile(`${trickySource}/README.md`, "# foo__bar\n");
sh(
	`git -C ${trickySource} add -A && git -C ${trickySource} commit -qm 'chore: foo__bar baseline' && git -C ${trickySource} remote add origin ${trickyRemote} && git -C ${trickySource} push -q origin main`,
	FIXTURE,
);
const trickyCanonical = await call("ensure_task_repo", {
	branch: "feat/EVODP-60002_uri",
	source_path: trickySource,
	base_ref: "origin/main",
});
const trickyCanonicalPath = sh("pwd -P", `${ws}/foo__bar`);
const trickyLane = await call("ensure_task_repo", {
	task: "feat/EVODP-60002_uri",
	slot: "release",
	branch: "hotfix/EVODP-60007_release",
	source_path: trickySource,
	base_ref: "origin/main",
});
const topology = await call("task_status", {});
const topologyWorkspace = ((topology.taskWorkspaces ?? []) as Array<Json>).find(
	(s) => s.key === "feat_EVODP-60002_uri",
);
const topologyRepos = (topologyWorkspace?.repos ?? []) as Array<Json>;
const trickyCanonicalRepo = topologyRepos.find((r) => r.name === "foo__bar");
const trickyLaneRepo = topologyRepos.find((r) => r.name === "foo__bar__release");
ok(
	trickyCanonical.status === "created" &&
		trickyCanonicalRepo?.kind === "canonical" &&
		trickyCanonicalRepo?.slot === null &&
		trickyCanonicalRepo?.path === trickyCanonicalPath,
	"repository basename containing __ remains canonical",
);
ok(
	trickyLane.status === "created" &&
		trickyLaneRepo?.kind === "lane" &&
		trickyLaneRepo?.slot === "release",
	"lane is recognized only with a canonical sibling of the same Git repository",
);

// --- S6: deferred-hook evidence is bound to the staged tree -----------------
section("S6 deferred hook evidence");
const deferFile = `${ws}/producer/feature-defer.txt`;
await fs.writeFile(deferFile, "deferred work\n");
// Install a pre-commit hook that fails on everything (simulated external
// prerequisite); hooks of the source repo apply to its managed worktrees.
sh(
	`printf '#!/bin/sh\\necho "%s: external prerequisite missing" >&2\\nexit 1\\n' '${FAILED_STEP}' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`,
	PRODUCER,
);
const d1 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer.txt"],
	message: "feat: deferred work",
});
ok(d1.status === "commit_failed", `hook failure surfaces (got ${d1.status})`);
const stagedTree = String(d1.staged_tree ?? "");
ok(/^[0-9a-f]{40}$/.test(stagedTree), `commit_failed reports the staged tree identity (${stagedTree.slice(0, 12)}…)`);
const d2 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer.txt"],
	message: "feat: deferred work",
	deferred_hook: {
		blocker_kind: "external_prerequisite",
		failed_hook: "pre-commit",
		failed_step_command: FAILED_STEP,
		failure_reason: "sibling lib unpublished at this task stage",
		staged_tree: stagedTree,
		manual_checks: [{ command: "manual smoke against published lib", result: "pass" }],
		remaining_gap: "re-run deferred check once lib is published",
	},
});
ok(d2.status === "committed_with_deferred_hook", `tree-bound evidence authorizes bypass (got ${d2.status})`);
// Wrong tree: new staged content, stale evidence from the previous tree.
await fs.writeFile(`${ws}/producer/feature-defer-2.txt`, "more deferred work\n");
const d3 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer-2.txt"],
	message: "feat: deferred work 2",
});
const staleTree = String(d3.staged_tree ?? "");
const d4 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer-2.txt"],
	message: "feat: deferred work 2",
	deferred_hook: {
		blocker_kind: "external_prerequisite",
		failed_hook: "pre-commit",
		failed_step_command: FAILED_STEP,
		failure_reason: "sibling lib unpublished at this task stage",
		staged_tree: stagedTree, // evidence from the FIRST tree, not the current one
		manual_checks: [{ command: "manual smoke against published lib", result: "pass" }],
		remaining_gap: "re-run deferred check once lib is published",
	},
});
ok(
	d4.status === "deferred_hook_rejected" && d4.evidenceTreeMatches === false,
	`stale evidence for a different staged tree rejected (got ${d4.status})`,
);
const d5 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer-2.txt"],
	message: "feat: deferred work 2",
	deferred_hook: {
		blocker_kind: "external_prerequisite",
		failed_hook: "pre-commit",
		failed_step_command: FAILED_STEP,
		failure_reason: "sibling lib unpublished at this task stage",
		staged_tree: staleTree,
		manual_checks: [{ command: "manual smoke against published lib", result: "skipped — no time" }],
		remaining_gap: "re-run deferred check once lib is published",
	},
});
ok(
	d5.status === "deferred_hook_rejected" && d5.checksComplete === false,
	`non-pass manual check result rejected (got ${d5.status})`,
);
// Fresh evidence for the CURRENT tree authorizes the bypass.
const d6 = await call("checkpoint_commit", {
	repo: `${ws}/producer`,
	paths: ["feature-defer-2.txt"],
	message: "feat: deferred work 2",
	deferred_hook: {
		blocker_kind: "external_prerequisite",
		failed_hook: "pre-commit",
		failed_step_command: FAILED_STEP,
		failure_reason: "sibling lib unpublished at this task stage",
		staged_tree: staleTree,
		manual_checks: [{ command: "manual smoke against published lib", result: "PASS" }],
		remaining_gap: "re-run deferred check once lib is published",
	},
});
ok(d6.status === "committed_with_deferred_hook", `current-tree evidence with machine-readable pass commits (got ${d6.status})`);
sh("rm -f .git/hooks/pre-commit", PRODUCER);

// --- S7: secondary lane cleanup is explicit and non-destructive -------------
section("S7 secondary lane cleanup");
const canonicalRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: `${ws}/producer`,
});
ok(
	canonicalRemoval.status === "lane_rejected",
	"canonical worktree cannot be removed as a lane",
);
const trickyCanonicalRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: trickyCanonicalPath,
});
ok(
	trickyCanonicalRemoval.status === "lane_rejected",
	"canonical foo__bar cannot be removed as a lane",
);
const trickyLaneRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: `${ws}/foo__bar__release`,
});
const trickyCanonicalExists = await fs
	.stat(trickyCanonicalPath)
	.then(() => true)
	.catch(() => false);
const trickyLaneExists = await fs
	.stat(`${ws}/foo__bar__release`)
	.then(() => true)
	.catch(() => false);
ok(
	trickyLaneRemoval.status === "removed" &&
		trickyCanonicalExists &&
		!trickyLaneExists,
	"cleanup removes foo__bar__release without removing canonical foo__bar",
);

const dirtyLanePath = `${ws}/producer__dirty-lane`;
const dirtyLane = await call("ensure_task_repo", {
	task: "feat/EVODP-60002_uri",
	slot: "dirty-lane",
	branch: "hotfix/EVODP-60002_dirty",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
ok(dirtyLane.status === "created", "clean lane can be created for cleanup coverage");
await fs.writeFile(`${dirtyLanePath}/dirty.txt`, "uncommitted\n");
const dirtyRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: dirtyLanePath,
});
ok(
	dirtyRemoval.status === "lane_dirty" &&
		((dirtyRemoval.dirty as Json)?.unstaged as string[]).includes("dirty.txt"),
	"dirty lane is rejected and its dirty facts are returned",
);
const dirtyStatus = await call("task_status", {});
const dirtyStatusRepo = (
	((dirtyStatus.taskWorkspaces ?? []) as Array<Json>).find(
		(s) => s.key === "feat_EVODP-60002_uri",
	)?.repos as Array<Json>
).find((r) => r.name === "producer__dirty-lane");
ok(
	((dirtyStatusRepo?.dirty as Json)?.unstaged as string[]).includes("dirty.txt"),
	"task_status exposes dirty state for the retained lane",
);

const unmergedLanePath = `${ws}/producer__unmerged-lane`;
const unmergedLane = await call("ensure_task_repo", {
	task: "feat/EVODP-60002_uri",
	slot: "unmerged-lane",
	branch: "hotfix/EVODP-60002_unmerged",
	source_path: PRODUCER,
	base_ref: "origin/develop",
});
ok(unmergedLane.status === "created", "unmerged lane can be created for safe-delete coverage");
await fs.writeFile(`${unmergedLanePath}/unmerged.txt`, "committed\n");
sh("git add unmerged.txt && git commit -qm 'test: unmerged lane history'", unmergedLanePath);
const unmergedRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: unmergedLanePath,
});
ok(
	unmergedRemoval.status === "branch_delete_blocked" &&
		!((await fs.stat(unmergedLanePath).then(() => true).catch(() => false))),
	"unmerged lane worktree is removed but safe branch deletion blocks",
);
ok(
	sh("git show-ref --verify refs/heads/hotfix/EVODP-60002_unmerged >/dev/null && echo yes", PRODUCER) ===
		"yes",
	"unmerged lane branch history is retained after cleanup blocker",
);

const cleanRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: `${ws}/producer__develop-backport`,
});
ok(
	cleanRemoval.status === "removed" &&
		!((await fs.stat(`${ws}/producer__develop-backport`).then(() => true).catch(() => false))),
	"clean secondary lane is removed through the managed lifecycle path",
);
ok(
	sh("git show-ref --verify refs/heads/hotfix/EVODP-60002_uri >/dev/null && echo yes", PRODUCER) !==
		"yes",
	"clean lane branch is deleted only with safe branch -d",
);
const unknownRemoval = await call("remove_task_lane", {
	task: "feat/EVODP-60002_uri",
	path: "/tmp/not-a-managed-lane",
});
ok(unknownRemoval.status === "lane_rejected", "unknown or non-managed lane path is rejected");

console.log(`\ndeep-guard scenario run complete on ${path.join(EXTENSIONS_DIR, "task-workspace.ts")}`);
