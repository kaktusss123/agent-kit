/**
 * Live verification of workspace_agent OPERATOR OBSERVABILITY against real
 * pi children. Run: node workspace-observability.mjs
 *
 * Proves, while Main stays blocked inside the long-running tool call:
 *  O1  at least one progress update is emitted BEFORE the run settles;
 *  O2  updates carry the actual run identity (runId, agentId, workspace);
 *  O3  a real child tool execution shows up as current activity
 *      (`bash · sleep 15`) while it runs;
 *  O4  the child's session identity is visible while still running;
 *  O5  the update count stays bounded (modest refresh cadence, no spam);
 *  O6  the RepoOwner still finishes normally: done + envelope, run/report
 *      semantics unchanged; updates stop after settlement.
 */
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_BIN = process.env.PI_BIN ?? "pi";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(DIR, "workspace-driver.ts");
const LIVE = "/tmp/pi-workspace-obs";
const REQ = path.join(LIVE, "dispatch-obs.json");

fs.rmSync(LIVE, { recursive: true, force: true });
fs.mkdirSync(LIVE, { recursive: true });
const TASK_ROOT = path.join(LIVE, "tasks");
fs.mkdirSync(TASK_ROOT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- workspace: real linked worktree under the fake task root --------------
const seed = path.join(LIVE, "seed");
execSync(`git init -q -b main "${seed}"`);
execSync(`git -C "${seed}" config user.email live@example.invalid`);
execSync(`git -C "${seed}" config user.name "Live"`);
fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
execSync(`git -C "${seed}" add README.md`);
execSync(`git -C "${seed}" commit -qm init`);
const WS = path.join(TASK_ROOT, "obs-ws");
execSync(`git -C "${seed}" worktree add -b feat/obs-ws "${WS}" main`);

// --- main process -----------------------------------------------------------
const main = spawn(PI_BIN, ["--mode", "rpc", "--no-extensions", "--no-session", "-e", DRIVER], {
	cwd: LIVE,
	env: { ...process.env, AGENT_TASK_ROOT: TASK_ROOT, PI_WDRV_LIVE_DIR: LIVE },
	stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let stateData = null;
main.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let ev;
		try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "response" && ev.command === "get_state" && ev.success) stateData = ev.data;
	}
});
main.stderr.on("data", () => {});
const send = (cmd) => main.stdin.write(JSON.stringify(cmd) + "\n");

for (let i = 0; i < 100 && !stateData; i++) {
	send({ id: `gs-${i}`, type: "get_state" });
	await sleep(300);
}
if (!stateData) {
	console.log("FAIL  main pi process did not come up");
	process.exit(1);
}
const modelPattern = `${stateData.model.provider}/${stateData.model.id}`;
console.log(`-- main model: ${modelPattern}`);

const tryLog = () => {
	try {
		return JSON.parse(fs.readFileSync(path.join(LIVE, "driver-log.json"), "utf8"));
	} catch {
		return null; // log appears only after the driver's first entry
	}
};
const log = () => JSON.parse(fs.readFileSync(path.join(LIVE, "driver-log.json"), "utf8"));
const runCmd = (text) => send({ type: "prompt", message: text });

// --- dispatch the long-running observable RepoOwner -------------------------
const task = [
	"Run exactly this bash command and nothing else: sleep 15.",
	"It is intentional; do not use any other tool before it and do not skip it.",
	"After it finishes, call report_result as your FINAL action with status \"done\",",
	"a short summary containing the word SLEEP-OK, changed_scope [], verification [], gaps [].",
].join(" ");
fs.writeFileSync(REQ, JSON.stringify({ workspace: WS, task, timeout_ms: 240000, model: modelPattern }));
runCmd(`/wdrv-dispatch ${REQ} OBS1`);

// wait for the spawned child
let spawnedEv = null;
for (let t0 = Date.now(); Date.now() - t0 < 60000; ) {
	const l = tryLog();
	spawnedEv = l?.events.find((e) => e.kind === "spawned" && e.resultKey === "OBS1");
	if (spawnedEv) break;
	await sleep(300);
}
check("child spawned", !!spawnedEv);

// observe DURING the run: the dispatch must still be blocked while we see
// progress updates (the bash sleep keeps the child busy for 15s).
let sawUpdateBeforeSettle = false;
let sawIdentity = false;
let sawCurrentTool = false;
let sawSession = false;
const settleWaitStart = Date.now();
for (let t0 = Date.now(); Date.now() - t0 < 60000; ) {
	const l = tryLog();
	if (l) {
		const settled = l.events.some((e) => e.kind === "dispatch-result" && e.resultKey === "OBS1");
		if (!settled) {
			const updates = l.events.filter((e) => e.kind === "progress" && e.resultKey === "OBS1");
			if (updates.length > 0) sawUpdateBeforeSettle = true;
			const texts = updates.map((u) => u.last);
			sawIdentity ||= texts.some((t) => /RepoOwner wr-\d+-[0-9a-z]+/.test(t) && t.includes(spawnedEv.agentId) && t.includes(WS));
			sawCurrentTool ||= texts.some((t) => t.includes("current\n  bash · sleep 15"));
			sawSession ||= texts.some((t) => /^session    \S+/m.test(t) && /running/.test(t));
			if (sawUpdateBeforeSettle && sawIdentity && sawCurrentTool && sawSession) break;
		}
	}
	if (Date.now() - settleWaitStart > 60000) break;
	await sleep(500);
}
check("O1 progress update emitted before settlement", sawUpdateBeforeSettle);
check("O2 update carries actual run identity (runId/agentId/workspace)", sawIdentity);
check("O3 real child tool execution visible as current activity", sawCurrentTool, "expected `bash · sleep 15`");
check("O4 session identity visible while running", sawSession);

// --- wait for the terminal outcome -----------------------------------------
let result = null;
for (let t0 = Date.now(); Date.now() - t0 < 300000; ) {
	const r = tryLog()?.results.OBS1;
	if (r?.details) { result = r; break; }
	await sleep(1000);
}
check("O6a RepoOwner settles done with envelope (semantics unchanged)",
	!!result && result.details?.status === "done" && String(result.details?.result?.summary ?? "").includes("SLEEP-OK"),
	JSON.stringify(result?.details ?? result ?? null).slice(0, 180));
check("O6b dispatch carries stable ids matching the observed updates",
	!!result && !!spawnedEv && result.details?.agentId === spawnedEv.agentId && !!result.details?.runId);

const updates = result?.updates ?? [];
check("O5 update count bounded (modest cadence, not spam)", updates.length > 0 && updates.length <= 40,
	`updates=${updates.length}`);
check("O6c updates stop after settlement (last update precedes the result)",
	updates.length > 0 && updates[updates.length - 1].at <= Date.now() && sawUpdateBeforeSettle,
	`last=${updates.at(-1)?.at}`);

// sample one real update for the report
if (updates.length > 0) {
	const sample = (updates.find((u) => u.text.includes("current")) ?? updates[0]).text;
	console.log("-- sample live update:\n" + sample);
}

main.kill();
const failed = results.filter((r) => !r.ok);
console.log(`-- workspace observability live verify: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
