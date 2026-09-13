/**
 * Live verification of the production subagents runtime against real pi
 * children. Run: node live-verify.mjs
 *
 * Phases:
 *  A. busy main + parallel children + escalation + cancel + crash
 *  B. idle-main wake-up
 *  C. steer + follow_up on the same child session
 *  D. near-simultaneous completions
 *  E. lazy results + child session inspectability
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

// PI_BIN override: path to a pi executable (bin shim or cli.js bundle).
const PI_BIN = process.env.PI_BIN ?? "pi";
const DRIVER = new URL("./driver.ts", import.meta.url).pathname;
const WORKDIR = "/tmp/pi-subagents-live";

fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.mkdirSync(WORKDIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const main = spawn(PI_BIN, ["--mode", "rpc", "--no-session", "-e", DRIVER], {
	cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const mainMessages = [];
let fetchedMessages = null;
let mainRuns = 0;
let uiRequests = [];

const send = (cmd) => main.stdin.write(JSON.stringify(cmd) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let ev;
		try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "message_end" && ev.message) mainMessages.push(ev.message);
		if (ev.type === "agent_start") mainRuns++;
		if (ev.type === "agent_settled") for (const w of settleWaiters.splice(0)) w();
		if (ev.type === "extension_ui_request") uiRequests.push(ev);
		if (ev.type === "response" && ev.command === "get_messages" && ev.success) fetchedMessages = ev.data?.messages ?? [];
	}
});
main.stderr.on("data", () => {});

const settleWaiters = [];
function waitForSettle(timeoutMs = 150000) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), timeoutMs);
		settleWaiters.push(() => { clearTimeout(t); resolve(true); });
	});
}

async function cmd(text) {
	send({ type: "prompt", message: text });
	await sleep(900);
}

async function fetchMessages() {
	fetchedMessages = null;
	send({ id: `gm-${Date.now()}`, type: "get_messages" });
	const t0 = Date.now();
	while (fetchedMessages === null && Date.now() - t0 < 10000) await sleep(200);
	return fetchedMessages ?? [];
}

async function driverNotify(prefix, timeoutMs = 15000) {
	uiRequests = [];
	send({ type: "prompt", message: prefix === "DRIVERLOG:" ? "/drv-log" : "/drv-sessions" });
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		await sleep(250);
		const req = uiRequests.find((e) => e.method === "notify" && typeof e.message === "string" && e.message.startsWith(prefix));
		if (req) return JSON.parse(req.message.slice(prefix.length));
	}
	throw new Error(`driver notify ${prefix} not received`);
}

async function pollLog(predicate, timeoutMs, label) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const log = await getLog();
		const hit = predicate(log);
		if (hit) return hit;
		await sleep(2000);
	}
	throw new Error(`pollLog timeout: ${label}`);
}

const getLog = () => driverNotify("DRIVERLOG:");
const getSnaps = () => driverNotify("DRIVERSNAP:");

// =============================================================================
// Phase A: busy main
// =============================================================================
console.log("\n== Phase A: busy main with parallel children ==");
send({ id: "p-busy", type: "prompt", message: "Use bash to run exactly: for i in $(seq 1 32); do sleep 1; done. Then reply with exactly: MAIN-BUSY-DONE." });
await sleep(6000); // main is now inside its 32s bash tool

const tSpawn = Date.now();
await cmd("/drv-spawn-sync slow1 9 SLOW1-DONE");
check("A1 spawn returns fast while main continues own work", Date.now() - tSpawn < 9000, `${Date.now() - tSpawn}ms incl cmd round-trip`);

await cmd("/drv-spawn slow2 7 SLOW2-DONE");
await cmd("/drv-spawn asker 0 A-ANSWERED ask");
await cmd("/drv-spawn doomed 60 DOOMED-DONE");
await cmd("/drv-spawn crasher 60 CRASHER-DONE");
await sleep(1500);

const logA = await getLog();
const crasher = [...logA].reverse().find((e) => e.kind === "spawned" && e.label === "crasher");
if (crasher?.pid) await cmd(`/drv-kill-pid ${crasher.pid}`);
else check("A5 crash becomes observable failed event", false, "crasher never spawned");

await sleep(12000); // let asker reach ask_parent
await cmd("/drv-respond asker BANANA-99");
await sleep(5000);
await cmd("/drv-respond asker BANANA-99"); // retry if not yet pending

const tCancel = Date.now();
await cmd("/drv-cancel doomed");
try {
	const entry = await pollLog((log) => log.find((e) => e.kind === "cancel-done" && e.ms !== undefined), 15000, "cancel-done");
	check("A2 cancel terminates child promptly", entry.ms < 10000, `${entry.ms}ms`);
} catch {
	check("A2 cancel terminates child promptly", false, "no cancel-done entry");
}

await waitForSettle(150000);
await sleep(1000);

const msgsA = await fetchMessages();
const customTexts = msgsA.filter((m) => m.role === "custom").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
check("A3 needs_input delivered to busy main", customTexts.some((t) => t.includes("needs input") && t.includes("magic word")), "");
check("A4 completions delivered to busy main (slow1+slow2+asker)", ["SLOW1-DONE", "SLOW2-DONE", "A-ANSWERED"].every((mark) => customTexts.some((t) => t.includes(mark) && t.includes("completed"))), "");
check("A5 crash becomes observable failed event", customTexts.some((t) => t.includes("failed") && t.includes("crasher")), "");
check("A6 no cancelled-event spam in model context", !customTexts.some((t) => t.includes("[subagent cancelled]")), "");

let orderOk = true;
for (let i = 0; i < msgsA.length - 1; i++) {
	const m = msgsA[i], n = msgsA[i + 1];
	if (m.role === "assistant" && (m.content ?? []).some((c) => c.type === "toolCall") && n.role !== "toolResult") orderOk = false;
}
check("A7 assistant/toolResult sequence never corrupted", orderOk, "");

const leaks = customTexts.filter((t) => t.includes("Use bash to run exactly"));
check("A8 no child transcript leak (compact events only)", leaks.length === 0, "");

{
	const log = await getLog();
	const latency = log.find((e) => e.kind === "spawn-latency");
	check("A9 spawn acceptance latency < 8s", !!latency && latency.ms < 8000, latency ? `${latency.ms}ms` : "missing");
}
try {
	const asker = await pollLog((log) => log.find((e) => e.kind === "completed" && String(e.summary ?? "").includes("A-ANSWERED")), 30000, "asker completed");
	check("A10 escalation: child resumed after respond, same run completed", !!asker, "");
} catch {
	check("A10 escalation: child resumed after respond, same run completed", false, "no completed event");
}

// =============================================================================
// Phase B: idle wake-up
// =============================================================================
console.log("\n== Phase B: idle main wake-up ==");
const runsBefore = mainRuns;
await cmd("/drv-spawn-sync idler 4 IDLER-DONE");
await sleep(18000);
check("B1 idle main woken by completion (run started without user input)", mainRuns > runsBefore, `${runsBefore}->${mainRuns}`);
const msgsB = await fetchMessages();
const bTexts = msgsB.filter((m) => m.role === "custom").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
check("B2 idle completion event present in main context", bTexts.some((t) => t.includes("IDLER-DONE")), "");

// =============================================================================
// Phase C: steer + follow_up on the same child session
// =============================================================================
console.log("\n== Phase C: steer and follow_up ==");
await cmd("/drv-spawn-sync worker 30 WORKER-FIRST");
await sleep(4000);
await cmd("/drv-steer worker After the sleep finishes, do NOT reply WORKER-FIRST. Instead reply exactly: WORKER-STEERED");
await cmd("/drv-wait worker");
try {
	const outcome = await pollLog((log) => log.find((e) => e.kind === "wait" && e.outcome?.status === "completed"), 120000, "steered completion");
	check("C1 steer redirects a running child, same session", String(outcome.outcome.summary).includes("WORKER-STEERED"), String(outcome.outcome.summary).slice(0, 60));
} catch {
	check("C1 steer redirects a running child, same session", false, "no wait outcome");
}

await cmd("/drv-followup worker Now reply with exactly: WORKER-FOLLOWUP");
await cmd("/drv-wait worker");
try {
	const outcome = await pollLog((log) => {
		const waits = log.filter((e) => e.kind === "wait");
		return waits.find((e) => String(e.outcome?.summary ?? "").includes("WORKER-FOLLOWUP"));
	}, 120000, "follow-up completion");
	check("C2 follow_up runs after current work, same session", true, String(outcome.outcome.summary).slice(0, 60));
} catch {
	check("C2 follow_up runs after current work, same session", false, "no follow-up wait outcome");
}

// =============================================================================
// Phase D: near-simultaneous completions
// =============================================================================
console.log("\n== Phase D: two children settle almost simultaneously ==");
await cmd("/drv-spawn pair-a 4 PAIR-A-DONE");
await cmd("/drv-spawn pair-b 4 PAIR-B-DONE");
await sleep(20000);
{
	const log = await getLog();
	const pairDone = log.filter((e) => e.kind === "completed" && /PAIR-(A|B)-DONE/.test(String(e.summary ?? "")));
	check("D1 both near-simultaneous completions delivered, none lost", pairDone.length === 2, `${pairDone.length}/2`);
}

// =============================================================================
// Phase E: results + child sessions
// =============================================================================
console.log("\n== Phase E: results and child sessions ==");
await cmd("/drv-result worker");
{
	const log = await getLog();
	const workerResult = [...log].reverse().find((e) => e.kind === "result")?.result;
	check("E1 lazy result carries final text + session + timing", !!workerResult && !!workerResult.sessionFile && !!workerResult.finalText && !!workerResult.startedAt, workerResult ? `status=${workerResult.status} text=${String(workerResult.finalText).slice(0, 40)}` : "no result entry");
}

const snaps = await getSnaps();
const sessionFiles = snaps.map((s) => s.sessionFile).filter(Boolean);
let sessionsValid = sessionFiles.length > 0;
let sessionsNamed = true;
for (const f of sessionFiles) {
	try {
		const content = fs.readFileSync(f, "utf8");
		const first = JSON.parse(content.split("\n")[0]);
		if (first.type !== "session") sessionsValid = false;
		if (!content.includes("subagent:")) sessionsNamed = false;
	} catch {
		sessionsValid = false;
		sessionsNamed = false;
	}
}
check("E2 child sessions are valid pi sessions on disk", sessionsValid, `${sessionFiles.length} files`);
check("E3 child sessions carry subagent:<label> name (discoverable)", sessionsNamed, "");

const totalCustom = (await fetchMessages()).filter((m) => m.role === "custom").length;
check("E4 main context stayed compact", totalCustom < 25, `${totalCustom} custom messages`);

console.log("\n== SUMMARY ==");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) console.log("FAILED:", failed.map((f) => f.name).join(", "));

main.kill("SIGTERM");
setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 800);
