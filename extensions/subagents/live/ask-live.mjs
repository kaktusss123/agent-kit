/**
 * Live verification of the portable `ask` contract (SPEC §19) against real pi
 * processes. Run: node ask-live.mjs
 *
 * Phases:
 *  P1  Main active toolset contains `ask` with the canonical schema; the
 *      child bridge exposes `ask` and no `ask_parent` (A10, I1, I4).
 *  P2  Main (RPC mode -> degraded select path) calls `ask`; the probe answers
 *      the extension_ui_request; main receives the selection and continues.
 *  P3  Child calls `ask`: main receives the STRUCTURED request (ids, options,
 *      §10 resolution wording) and `respond` resumes the same child run.
 *
 * Auto-resolution of child asks from main context (SPEC §9) is model-driven
 * by design; its contract is unit-tested (RESOLVE_INSTRUCTION wording), and
 * the wording is asserted live in P3. The model-behavior probe stays manual.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const PI_BIN = process.env.PI_BIN ?? "pi";
const LIVE_DIR = new URL(".", import.meta.url).pathname;
const DRIVER = new URL("./driver.ts", import.meta.url).pathname;
const ASK_EXT = new URL("../../ask/index.ts", import.meta.url).pathname;
const WORKDIR = "/tmp/pi-ask-live";

fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.mkdirSync(WORKDIR, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const main = spawn(
	PI_BIN,
	["--mode", "rpc", "--no-session", "-e", DRIVER, "-e", ASK_EXT],
	{ cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
const mainMessages = [];
let fetchedMessages = null;
let uiRequests = [];
const settleWaiters = [];
let childTools = null; // set by P3 via /drv-tools inside the CHILD? (children have no driver) — unused

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
		if (ev.type === "agent_settled") for (const w of settleWaiters.splice(0)) w();
		if (ev.type === "extension_ui_request") uiRequests.push(ev);
		if (ev.type === "response" && ev.command === "get_messages" && ev.success) fetchedMessages = ev.data?.messages ?? [];
	}
});
main.stderr.on("data", () => {});

function waitForSettle(timeoutMs = 150000) {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), timeoutMs);
		settleWaiters.push(() => { clearTimeout(t); resolve(true); });
	});
}

async function fetchMessages() {
	fetchedMessages = null;
	send({ id: `gm-${Date.now()}`, type: "get_messages" });
	const t0 = Date.now();
	while (fetchedMessages === null && Date.now() - t0 < 10000) await sleep(200);
	return fetchedMessages ?? [];
}

async function driverNotify(prefix, cmdText, timeoutMs = 15000) {
	uiRequests = [];
	send({ type: "prompt", message: cmdText });
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		await sleep(250);
		const req = uiRequests.find((e) => e.method === "notify" && typeof e.message === "string" && e.message.startsWith(prefix));
		if (req) return JSON.parse(req.message.slice(prefix.length));
	}
	throw new Error(`driver notify ${prefix} not received for ${cmdText}`);
}

const getLog = () => driverNotify("DRIVERLOG:", "/drv-log");

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

async function cmd(text) {
	send({ type: "prompt", message: text });
	await sleep(900);
}

// ===========================================================================
// P1: toolset contract
// ===========================================================================
console.log("\n== P1: main toolset contains canonical ask ==");
await sleep(2000);
const tools = await driverNotify("DRIVERTOOLS:", "/drv-tools");
const askTool = tools.find((t) => t.name === "ask");
check("P1a main registers `ask`", !!askTool, askTool ? "" : `tools: ${tools.map((t) => t.name).join(",")}`);
const schema = askTool?.parameters ?? {};
const q = schema.properties?.questions?.items?.properties ?? {};
check(
	"P1b schema is the canonical AskInput (questions/options/multi/recommended/id/preview)",
	schema.properties?.questions?.type === "array" &&
		typeof q.id === "object" &&
		typeof q.question === "object" &&
		typeof q.options === "object" &&
		typeof q.multi === "object" &&
		typeof q.recommended === "object" &&
		typeof q.options?.items?.properties?.preview === "object",
	JSON.stringify(Object.keys(q)),
);
check(
	"P1c no model-facing ask_parent anywhere",
	!tools.some((t) => t.name.includes("ask_parent")),
);

// ===========================================================================
// P2: main ask itself through the degraded RPC path
// ===========================================================================
console.log("\n== P2: main ask via RPC fallback, probe answers the select ==");
const settleP2 = waitForSettle();
await cmd(
	`Use the ask tool with exactly this call and no other tools: questions: [{ id: "storage", question: "Which storage backend?", options: [{ label: "PostgreSQL", description: "proven RDBMS" }, { label: "SQLite", description: "embedded" }], recommended: 0 }]`,
);
// wait for the select request (fallback ui.select per question)
let selectReq = null;
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !selectReq) {
	await sleep(500);
	selectReq = uiRequests.find((e) => e.method === "select" && (e.title ?? "").includes("Which storage backend?"));
}
check("P2a fallback select request reaches the host with question title", !!selectReq, selectReq ? selectReq.title : "no select request");
if (selectReq) {
	check(
		"P2b options are rendered as selectable strings",
		Array.isArray(selectReq.options) && selectReq.options.some((o) => String(o).startsWith("PostgreSQL")),
		JSON.stringify(selectReq.options),
	);
	const chosen = selectReq.options.find((o) => String(o).startsWith("PostgreSQL"));
	send({ type: "extension_ui_response", id: selectReq.id, value: chosen });
	// the fallback shows a review step before submitting
	let reviewReq = null;
	const tRev = Date.now();
	while (Date.now() - tRev < 30000 && !reviewReq) {
		await sleep(400);
		reviewReq = uiRequests.find((e) => e.method === "select" && (e.title ?? "").includes("Review your answers"));
	}
	check("P2c fallback review step is shown before submit (A2)", !!reviewReq);
	if (reviewReq) send({ type: "extension_ui_response", id: reviewReq.id, value: "Submit answers" });
	await settleP2;
	await sleep(1000);
	const msgs = await fetchMessages();
	const transcript = JSON.stringify(msgs);
	check("P2d main received the selection and continued", transcript.includes("User selected: PostgreSQL"));
} else {
	check("P2b options are rendered as selectable strings", false, "no select request");
	check("P2c fallback review step is shown before submit (A2)", false, "no select request");
	check("P2d main received the selection and continued", false, "no select request");
	await waitForSettle(60000);
}

// ===========================================================================
// P3: child asks; main gets the structured request; respond resumes it
// ===========================================================================
console.log("\n== P3: child ask -> structured needs_input -> respond -> resume ==");
await cmd("/drv-spawn asker 0 ASK-LIVE-ANSWERED ask");
let needsInput = null;
try {
	needsInput = await pollLog(
		(log) => log.find((e) => e.kind === "needs_input"),
		150000,
		"child needs_input",
	);
} catch {
	const log = await getLog().catch(() => []);
	console.log("driver log tail:", JSON.stringify(log.slice(-8), null, 2));
	check("P3a needs_input carries the lossless structured request (A5)", false, "no needs_input; see log tail");
}
const delivered = needsInput ? needsInput.request : null;
check(
	"P3a needs_input carries the lossless structured request (A5)",
	!!delivered &&
		delivered.questions?.[0]?.id === "magic" &&
		Array.isArray(delivered.questions[0].options) &&
		delivered.questions[0].options.some((o) => o.label === "abra"),
	JSON.stringify(delivered),
);

// give the delivery wiring a moment, then check the model-visible wording
await sleep(4000);
const msgs3 = await fetchMessages();
const custom3 = msgs3.filter((m) => m.role === "custom").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const deliveryText = custom3.find((t) => t.includes("needs input") && t.includes("magic"));
check("P3b delivery carries §10 resolution wording", !!deliveryText && deliveryText.includes("already established"), deliveryText?.slice(0, 200));

// A4 live: the answer is NOT established in main's context, so per the §10
// instruction the model should escalate via its own `ask` (fallback select).
// The probe plays the user: answer "abra" on the model's own request.
let escalated = null;
const tEsc = Date.now();
while (Date.now() - tEsc < 90000 && !escalated) {
	await sleep(500);
	escalated = uiRequests.find((e) => e.method === "select" && (e.title ?? "").includes("What magic word"));
}
if (escalated) {
	send({ type: "extension_ui_response", id: escalated.id, value: "abra" });
	console.log("INFO  P3c main escalated the unknown decision via its own ask (A4) — observed");
} else {
	// Model-driven by design (SPEC §9/§19): weaker defaults may answer from
	// context or ask differently. The A4 wording/contract checks are P3b and
	// the unit suite; the model-behavior probe stays manual.
	console.log("INFO  P3c model did not escalate via its own ask within 90s (model-dependent; A4 auto-resolution probed manually)");
}

// The model should now respond to the child; fall back to a direct respond
// if it dawdles (mechanics probe, not a model-behavior exam).
let done = null;
const tDone = Date.now();
while (Date.now() - tDone < 100000) {
	try {
		done = await pollLog(
			(log) => log.find((e) => e.kind === "completed" && String(e.summary ?? "").includes("ASK-LIVE-ANSWERED")),
			15000,
			"asker completed",
		);
		break;
	} catch {
		if (Date.now() - tDone > 90000) break;
		await cmd("/drv-respond asker abra"); // idempotent-ish: errors when nothing pending
	}
}
check("P3d child resumed and completed the same run", !!done);

// ===========================================================================
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
main.kill("SIGTERM");
process.exit(failed.length === 0 ? 0 : 1);
