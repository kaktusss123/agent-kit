/**
 * Live verification of workspace-mode subagent spawns against real pi children.
 * Run: node workspace-verify.mjs   (after `bun test` — needs the repo tree)
 *
 * Scenarios:
 *  L1 (A1/A5/A8/A13/L7) happy path: rooted child creates + commits via
 *                       checkpoint_commit, reports done; transcript proves the
 *                       commit path; model pinned; process retired; query-mode
 *                       returns the same envelope as the notification.
 *  L2 (A3)              deadline mid-run → partial + mutated, process killed.
 *  L3 (A6/A6b)          needs_input → respond → done; notification vs query.
 *  L4 (A14)             explicit Main cancel → blocked cancelled_by_main.
 *  L5 (A9/A12)          generic child regression + allow-list policy.
 *  L6 (A2)              non-worktree dispatch → unsupported, no process.
 *  L10 (R3.4)           fail-closed profile: missing entry → unsupported + no
 *                       process; broken capability (registers nothing) →
 *                       readiness handshake fails, child killed, task never
 *                       reaches a model.
 */
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_BIN = process.env.PI_BIN ?? "pi";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(DIR, "workspace-driver.ts");
const LIVE = "/tmp/pi-workspace-live";
const REQ = (key) => path.join(LIVE, `dispatch-${key}.json`);

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
const SUITE_START = Date.now();

// --- workspace: real linked worktree under the fake task root --------------
const seed = path.join(LIVE, "seed");
execSync(`git init -q -b main "${seed}"`);
execSync(`git -C "${seed}" config user.email live@example.invalid`);
execSync(`git -C "${seed}" config user.name "Live"`);
fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
execSync(`git -C "${seed}" add README.md`);
execSync(`git -C "${seed}" commit -qm init`);
const WS = path.join(TASK_ROOT, "live-ws");
execSync(`git -C "${seed}" worktree add -b feat/live-ws "${WS}" main`);

// --- main process -----------------------------------------------------------
const main = spawn(PI_BIN, ["--mode", "rpc", "--no-extensions", "--no-session", "-e", DRIVER], {
	cwd: LIVE,
	env: { ...process.env, AGENT_TASK_ROOT: TASK_ROOT },
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

let lastGoodLog = null;
const log = () => {
	try {
		lastGoodLog = JSON.parse(fs.readFileSync(path.join(LIVE, "driver-log.json"), "utf8"));
	} catch { /* torn read or not written yet */ }
	if (lastGoodLog === null) throw new Error("no log yet");
	return lastGoodLog;
};
const waitResult = async (key, timeoutMs) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const l = log();
			if (l.results[key] !== undefined) return l.results[key];
		} catch { /* log not written yet */ }
		await sleep(500);
	}
	return null;
};
const runCmd = (text) => send({ type: "prompt", message: text });
const dispatchCmd = (key, params) => {
	fs.writeFileSync(REQ(key), JSON.stringify({ model: modelPattern, ...params }));
	runCmd(`/wdrv-dispatch ${REQ(key)} ${key}`);
};

// ---------------- L6: pre-dispatch gate (non-worktree) ----------------------
{
	dispatchCmd("L6", { workspace: path.join(LIVE, "not-a-worktree"), task: "x" });
	const r = await waitResult("L6", 30000);
	check(
		"L6/A2 non-worktree → unsupported, dispatched:false",
		!!r && r.details?.status === "unsupported" && r.details?.dispatched === false,
		JSON.stringify(r?.details ?? r).slice(0, 160),
	);
}

// ---------------- L1: happy path (A1, A5, A8, A13, L7) ----------------------
const task1 = [
	"Managed worktree task. Work only inside the current directory.",
	"1. Create a file hello.txt containing the word hello.",
	'2. Commit it by calling the checkpoint_commit tool with repo=".", paths=["hello.txt"], message="add hello".',
	"3. Run `git log --oneline -1` via bash to verify the commit exists.",
	'4. Call report_result as your FINAL action with status "done", a short summary, changed_scope ["hello.txt"], verification [{check: "git log shows the commit", result: "pass"}], gaps [].',
	"Never use raw `git commit` in bash; checkpoint_commit is the only commit path.",
].join(" ");
{
	dispatchCmd("L1", { workspace: WS, task: task1, timeout_ms: 420000 });
	const r = await waitResult("L1", 480000);
	check("L1/A1 dispatch → done", !!r && r.details?.status === "done", JSON.stringify(r?.details ?? r).slice(0, 220));
	if (r?.details?.status === "done") {
		const env = r.details.result;
		check("L1 envelope verification pass", env?.verification?.[0]?.result === "pass", JSON.stringify(env?.verification));
		check("L1 changed_scope names hello.txt", JSON.stringify(env?.changed_scope).includes("hello.txt"));
		const hello = path.join(WS, "hello.txt");
		check("L1 file exists in worktree", fs.existsSync(hello) && fs.readFileSync(hello, "utf8").includes("hello"));
		const gitLog = execSync(`git -C "${WS}" log --oneline -2`).toString();
		check("L1 commit landed in worktree", /add hello/.test(gitLog), gitLog.trim());

		const l = log();
		const spawnedEv = l.events.find((e) => e.kind === "spawned" && e.resultKey === "L1");
		check("L1/A8 model pinned to main model", !!spawnedEv && spawnedEv.model === modelPattern, `child=${spawnedEv?.model}`);

		const tr = childTranscript(WS);
		check("L1 transcript: checkpoint_commit used", !!tr && tr.checkpointCalls >= 1, `calls=${tr?.checkpointCalls} session=${tr?.session ? "found" : "missing"}`);
		check("L1/A5 transcript: zero raw `git commit` and zero --no-verify", !!tr && tr.rawBashCommit === 0 && tr.noVerify === 0, `raw=${tr?.rawBashCommit} noVerify=${tr?.noVerify}`);

		const pid = spawnedEv?.pid;
		let alive = true;
		try { process.kill(pid, 0); } catch { alive = false; }
		check("L1/A13 child process retired after done", pid && !alive, `pid=${pid} alive=${alive}`);

		runCmd(`/wdrv-view ${r.details.agentId} L1Q`);
		const q = await waitResult("L1Q", 20000);
		check(
			"L7 run registry returns the same terminal envelope",
			!!q && q.details?.terminal?.status === "done" && q.details?.terminal?.result?.summary === env.summary,
			JSON.stringify(q?.details ?? q).slice(0, 160),
		);
	}
}

// ---------------- L2: deadline (A3) -----------------------------------------
{
	dispatchCmd("L2", {
		workspace: WS,
		task: "Run exactly this bash command and nothing else: sleep 45. It is intentional; do not use any other tool and do not call report_result.",
		timeout_ms: 20000,
	});
	const r = await waitResult("L2", 90000);
	const l = log();
	const ev = l.events.find((e) => e.kind === "spawned" && e.resultKey === "L2");
	let alive = true;
	try { process.kill(ev?.pid, 0); } catch { alive = false; }
	check(
		"L2/A3 deadline → partial + mutated + process killed",
		!!r && r.details?.status === "partial" && r.details?.reason === "deadline" && r.details?.child_may_have_mutated_repo === true && !alive,
		JSON.stringify(r?.details ?? r).slice(0, 160) + ` alive=${alive}`,
	);
}

// ---------------- L3: needs_input (A6, A6b) ---------------------------------
{
	const task3 = [
		"Call ask with the question: What is the magic word?",
		"Then reply with the word you received and call report_result as your FINAL action with status done, a summary mentioning the magic word, changed_scope [], verification [], gaps [].",
	].join(" ");
	dispatchCmd("L3", { workspace: WS, task: task3, timeout_ms: 180000 });
	const l0 = await waitResult("L3", 120000); // the dispatch call returns at needs_input
	check(
		"L3/A6 dispatch returns needs_input with ids",
		!!l0 && l0.details?.status === "needs_input" && !!l0.details?.agentId,
		JSON.stringify(l0?.details ?? l0).slice(0, 160),
	);
	if (l0?.details?.status === "needs_input") {
		const agentId = l0.details.agentId;
		// run must still be alive (suspended, not finished)
		const ev = log().events.find((e) => e.kind === "spawned" && e.resultKey === "L3");
		let alive = true;
		try { process.kill(ev?.pid, 0); } catch { alive = false; }
		check("L3 child process alive while waiting_input", alive);

		runCmd(`/wdrv-respond ${agentId} sesame`);
		// The dispatch call already returned; the terminal outcome shows up as
		// a completion notification plus the query-mode state.
		let q = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 300000) {
			await sleep(3000);
			runCmd(`/wdrv-view ${agentId} L3Q`);
			await sleep(1500);
			try {
				const l = log();
				q = l.results.L3Q;
				if (q?.details?.terminal?.status === "done") break;
			} catch { /* no log yet */ }
		}
		check("L3/A6 completed after respond", !!q && q.details?.terminal?.status === "done", JSON.stringify(q?.details ?? q).slice(0, 160));
		check("L3 envelope mentions the magic word", !!q?.details?.terminal?.result && JSON.stringify(q.details.terminal.result).includes("sesame"));
		const l = log();
		const notified = l.messages.find((m) => m.customType === "subagent-event" && String(m.content).includes(agentId) && String(m.content).includes('"status":"done"'));
		check("L3 [subagent completed] delivered with envelope", !!notified);

		// A6b: notification lost → durable query still returns the envelope
		check("L3/A6b run registry result identical to notification", !!q && !!notified && JSON.stringify(q.details.terminal.result) === (notified.content.match(/result: (.*)/) ?? [])[1]?.trim());
	}
}

// ---------------- L4: explicit Main cancel (A14) ----------------------------
{
	dispatchCmd("L4", {
		workspace: WS,
		task: "Run exactly this bash command and nothing else: sleep 120. It is intentional; do not use any other tool and do not call report_result.",
		timeout_ms: 300000,
	});
	// wait for spawn, then cancel as Main would via subagent op=cancel
	let ev = null;
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		try {
			ev = log().events.find((e) => e.kind === "spawned" && e.resultKey === "L4");
			if (ev) break;
		} catch { /* not yet */ }
		await sleep(300);
	}
	await sleep(2000);
	runCmd(`/wdrv-cancel ${ev.agentId}`);
	const r = await waitResult("L4", 60000);
	check(
		"L4/A14 cancel by Main → blocked cancelled_by_main + mutated, no result",
		!!r && r.details?.status === "blocked" && r.details?.reason === "cancelled_by_main" && r.details?.child_may_have_mutated_repo === true && r.details?.result === undefined,
		JSON.stringify(r?.details ?? r).slice(0, 160),
	);
}

// ---------------- L5: generic child regression (A9, A12) --------------------
{
	runCmd(`/wdrv-spawn-generic generic-1 Reply with exactly: GENERIC-OK`);
	let ev = null;
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		try {
			ev = log().events.find((e) => e.kind === "generic-spawned");
			if (ev) break;
		} catch { /* not yet */ }
		await sleep(300);
	}
	check("L5/A9 generic child spawned", !!ev);
	if (ev) {
		runCmd(`/wdrv-managed ${ev.agentId} L5M`);
		const m = await waitResult("L5M", 10000);
		check("L5/A12 generic child not workspace-owned", !!m && m.managed === false);
		// generic completion still flows through the generic policy
		let completed = false;
		const t1 = Date.now();
		while (Date.now() - t1 < 90000) {
			try {
				const l = log();
				completed = l.events.some((e) => e.kind === "generic-event" && e.event?.agentId === ev.agentId && e.event?.kind === "completed");
				if (completed) break;
			} catch { /* not yet */ }
			await sleep(500);
		}
		check("L5/A9 generic child completes via generic policy", completed);
	}
}

// ---------------- L7p: parallel owners (A7) ---------------------------------
{
	const WS2 = path.join(TASK_ROOT, "live-ws-2");
	execSync(`git -C "${seed}" worktree add -b feat/live-ws-2 "${WS2}" main`);
	const taskP = (file) =>
		[
			"Managed worktree task. Work only inside the current directory.",
			`1. Create a file ${file} containing the word done.`,
			'2. Commit it via checkpoint_commit with repo="." and paths=["' + file + '"], message="add ' + file + '".',
			"3. Call report_result as your FINAL action with status done, a short summary, changed_scope, verification [{check: \"file exists\", result: \"pass\"}], gaps [].",
		].join(" ");
	dispatchCmd("P1", { workspace: WS, task: taskP("alpha.txt"), timeout_ms: 240000 });
	dispatchCmd("P2", { workspace: WS2, task: taskP("beta.txt"), timeout_ms: 240000 });
	const [r1, r2] = await Promise.all([waitResult("P1", 300000), waitResult("P2", 300000)]);
	check("L7p/A7 owner 1 done", !!r1 && r1.details?.status === "done", JSON.stringify(r1?.details ?? r1).slice(0, 120));
	check("L7p/A7 owner 2 done", !!r2 && r2.details?.status === "done", JSON.stringify(r2?.details ?? r2).slice(0, 120));
	check("L7p/A7 mutations in their own worktrees", fs.existsSync(path.join(WS, "alpha.txt")) && fs.existsSync(path.join(WS2, "beta.txt")));
}

// ---------------- L8: staleness live (A11) ----------------------------------
{
	const task8 = [
		"Managed worktree task. Follow these steps EXACTLY in order:",
		'1. Call report_result with status "done", summary "FIRST REPORT", changed_scope [], verification [], gaps [].',
		"2. Then run `true` via bash (this invalidates the first report on purpose).",
		'3. Then call report_result AGAIN as your FINAL action with status "done", summary "SECOND REPORT FINAL", changed_scope [], verification [], gaps [].',
	].join(" ");
	dispatchCmd("L8", { workspace: WS, task: task8, timeout_ms: 180000 });
	const r = await waitResult("L8", 240000);
	check(
		"L8/A11 fresh second report wins after invalidation",
		!!r && r.details?.status === "done" && r.details?.result?.summary?.includes("SECOND REPORT"),
		JSON.stringify(r?.details?.result?.summary ?? r?.details ?? r).slice(0, 140),
	);
}

// ---------------- L9: deadline through needs_input (A3b) --------------------
{
	dispatchCmd("L9", {
		workspace: WS,
		task: "Call ask with the question: May I proceed? Then wait for the answer.",
		timeout_ms: 30000,
	});
	const first = await waitResult("L9", 60000); // needs_input
	check("L9/A3b needs_input reached", !!first && first.details?.status === "needs_input", JSON.stringify(first?.details ?? first).slice(0, 120));
	if (!first?.details?.agentId) {
		check("L9/A3b deadline through needs_input → partial + killed", false, "no agentId");
	} else {
		// Never respond: the deadline must fire through needs_input.
		let r = null;
		const t0 = Date.now();
		while (Date.now() - t0 < 120000) {
			await sleep(3000);
			runCmd(`/wdrv-view ${first.details.agentId} L9Q`);
			await sleep(1500);
			try {
				const l = log();
				const v = l.results.L9Q;
				if (v?.details?.terminal?.status === "partial") { r = v; break; }
			} catch { /* no log yet */ }
		}
		const l = log();
		const ev = l.events.find((e) => e.kind === "spawned" && e.resultKey === "L9");
		let alive = true;
		try { process.kill(ev?.pid, 0); } catch { alive = false; }
		check(
			"L9/A3b deadline through needs_input → partial + killed",
			!!r && r.details?.status === "partial" && r.details?.reason === "deadline" && !alive,
			JSON.stringify(r?.details ?? r).slice(0, 140) + ` alive=${alive}`,
		);
	}
}

// ---------------- L10: fail-closed profile (R3.4) ---------------------------
{
	// L10a: profile entry file missing → static preflight refuses before any
	// process exists.
	const missingEntry = path.join(LIVE, "definitely-missing-entry.ts");
	runCmd(`/wdrv-profile ${missingEntry}`);
	dispatchCmd("L10a", { workspace: WS, task: "this task must never reach a model", timeout_ms: 60000 });
	const r10a = await waitResult("L10a", 30000);
	const l10a = log();
	check(
		"L10a/R3.4 missing profile entry → unsupported, dispatched:false, no process",
		!!r10a && r10a.details?.status === "unsupported" && r10a.details?.dispatched === false
			&& !l10a.events.some((e) => e.kind === "spawned" && e.resultKey === "L10a"),
		JSON.stringify(r10a?.details ?? r10a).slice(0, 160),
	);

	// L10b: required capability broken (entry loads but registers NOTHING);
	// the readiness probe is loaded, so the handshake RUNS and reports
	// ok:false for the missing tools — the child is killed and the task is
	// never dispatched to a model.
	const emptyEntry = path.join(LIVE, "empty-entry.ts");
	fs.writeFileSync(emptyEntry, "export default function () {}\n");
	const probeEntry = path.join(DIR, "..", "readiness-probe.ts");
	runCmd(`/wdrv-profile ${emptyEntry},${probeEntry}`);
	dispatchCmd("L10b", { workspace: WS, task: "this task must never reach a model", timeout_ms: 60000 });
	const r10b = await waitResult("L10b", 60000);
	const l10b = log();
	const spawned10b = l10b.events.find((e) => e.kind === "spawned" && e.resultKey === "L10b");
	let alive10b = false;
	if (spawned10b?.pid) {
		for (let i = 0; i < 20; i++) {
			try { process.kill(spawned10b.pid, 0); await sleep(250); } catch { alive10b = false; break; }
			alive10b = true;
		}
	}
	check(
		"L10b/R3.4 broken capability → readiness fails, unsupported, dispatched:false, child killed",
		!!r10b && r10b.details?.status === "unsupported" && r10b.details?.dispatched === false
			&& !!spawned10b && !alive10b,
		JSON.stringify(r10b?.details ?? r10b).slice(0, 200) + ` killed=${spawned10b ? !alive10b : "n/a"}`,
	);

	runCmd("/wdrv-profile reset");
}

// ----------------------------------------------------------------------------
main.kill();

function childTranscript(ws) {
	try {
		// The child's cwd is the (realpath'd) worktree; pi encodes it into the
		// sessions directory name ("/" → "-"), so scope the search there. Take
		// the NEWEST session created during THIS suite run — earlier runs leave
		// sessions in the same directory with the same label.
		const real = fs.realpathSync(ws);
		const dirName = "-" + real.replace(/\//g, "-") + "--";
		const agentDir = path.join(process.env.HOME, ".pi", "agent", "sessions", dirName);
		let found = null;
		let foundMtime = 0;
		for (const f of fs.readdirSync(agentDir)) {
			const p = path.join(agentDir, f);
			const st = fs.statSync(p);
			if (st.isFile() && st.mtimeMs > SUITE_START - 5000 && f.endsWith(".jsonl")) {
				const head = fs.readFileSync(p, "utf8").slice(0, 4000);
				if (head.includes(`subagent:owner-${path.basename(ws)}`) && st.mtimeMs > foundMtime) {
					found = p;
					foundMtime = st.mtimeMs;
				}
			}
		}
		if (!found) return null;
		const transcript = fs.readFileSync(found, "utf8");
		return {
			session: found,
			checkpointCalls: (transcript.match(/"name":"checkpoint_commit"/g) ?? []).length,
			rawBashCommit: (transcript.match(/"command":"[^"]*/g) ?? []).filter((s) => /(^|[^_])\bgit commit\b/.test(s)).length,
			noVerify: (transcript.match(/--no-verify/g) ?? []).length,
		};
	} catch {
		return null;
	}
}

const failed = results.filter((r) => !r.ok);
console.log(`-- workspace live verify: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
