/**
 * Live verification of the `agentkit-status` read seam against a real
 * `pi --mode rpc` main process with the PRODUCTION subagents extension
 * loaded explicitly (--no-extensions -e <index.ts>). Run:
 *
 *   node status-verify.mjs   (needs the repo tree; S7–S9 need a real model)
 *
 * Scenarios:
 *  S1 (SPEC T1)  get_commands discovers agentkit-status.
 *  S2 (SPEC T2)  task area: structured task state; zero agent turns.
 *  S3 (SPEC T3)  subagents area before the first spawn: empty agents list.
 *  S4            all area: both keys in one payload; unknown area → error
 *                payload over the same dialog path.
 *  S5            controller answers cancelled:true → read completes cleanly.
 *                (implicit: every read above is answered with cancelled.)
 *  S6 (SPEC T7)  no controller answer → dialog carries timeout:15000, the
 *                prompt still returns success (fail-closed, ~15 s).
 *  S7 (SPEC T4)  live plain subagent (spawned by Main through the real
 *                tool): structured running state (pid, model, alive), then
 *                completed — reads never touch the main model.
 *  S8 (SPEC T5)  live workspace (RepoOwner) run: non-terminal run view while
 *                the spawn call blocks; terminal run.status after settlement.
 *  S9 (SPEC T6)  subagent op=status reports the same run view as the command
 *                (shared agentDetailView mapping cannot drift).
 *
 * Model-free: S1–S6 never touch an LLM (mainAgentStarts stays 0 throughout).
 * S7–S9 follow the research-probe pattern: Main is prompted to use its real
 * `subagent` tool, so spawn/status flow through the shipped closure that the
 * command reads.
 */
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_BIN = process.env.PI_BIN ?? "pi";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(DIR, "..", "index.ts");
const LIVE = "/tmp/pi-status-live";

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

// --- main process -----------------------------------------------------------
const main = spawn(PI_BIN, ["--mode", "rpc", "--no-extensions", "--no-session", "-e", INDEX], {
	cwd: LIVE,
	// The live main is a MAIN session: pin away an inherited PI_SUBAGENT_ID
	// (this suite may itself run inside a workspace worker) so the ownership
	// gate lets S8's RepoOwner spawn through.
	env: (() => {
		const env = { ...process.env, AGENT_TASK_ROOT: TASK_ROOT };
		delete env.PI_SUBAGENT_ID;
		return env;
	})(),
	stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const waiters = new Map(); // response id → {resolve, timer}
let readSeq = 0;
const pendingReads = []; // FIFO of {resolve, answer, timer}
let mainAgentStarts = 0;
let agentSettled = true; // agent_settled ↔ no streaming run; plain prompts are rejected mid-stream
const dialogTitles = new Set();

main.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "agent_start") {
			mainAgentStarts++;
			agentSettled = false;
		}
		if (ev.type === "agent_settled") agentSettled = true;
		if (ev.type === "response" && waiters.has(ev.id)) {
			const w = waiters.get(ev.id);
			waiters.delete(ev.id);
			clearTimeout(w.timer);
			w.resolve(ev);
		}
		if (ev.type === "extension_ui_request" && ev.method === "input" && ev.title === "agentkit:status") {
			dialogTitles.add(ev.title);
			const pending = pendingReads.shift();
			let payload = null;
			try {
				payload = JSON.parse(ev.placeholder);
			} catch {
				payload = null;
			}
			if (!pending) continue; // S6: no controller answer — leave it pending
			if (pending.answer) {
				main.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true }) + "\n");
			}
			clearTimeout(pending.timer);
			pending.resolve({ payload, request: ev });
		}
		if (ev.type === "extension_ui_request" && ev.title) dialogTitles.add(ev.title);
	}
});
main.stderr.on("data", () => {});
const send = (cmd) => main.stdin.write(JSON.stringify(cmd) + "\n");

const waitForResponse = (id, timeoutMs) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			waiters.delete(id);
			reject(new Error(`response ${id} timed out`));
		}, timeoutMs);
		waiters.set(id, { resolve, timer });
	});

const getState = async () => {
	for (let i = 0; i < 100; i++) {
		const w = waitForResponse(`gs-${i}`, 5000);
		send({ id: `gs-${i}`, type: "get_state" });
		try {
			const resp = await w;
			if (resp.success) return resp.data;
		} catch {
			/* retry */
		}
		await sleep(300);
	}
	return null;
};

/** One model-free status read: prompt the command, answer cancelled:true. */
const statusRead = (area, opts = {}) =>
	new Promise((resolve, reject) => {
		const entry = { resolve, answer: opts.answer !== false, timer: null };
		entry.timer = setTimeout(() => {
			const idx = pendingReads.indexOf(entry);
			if (idx !== -1) pendingReads.splice(idx, 1);
			reject(new Error(`status read (${area}) timed out`));
		}, opts.dialogTimeoutMs ?? 30000);
		pendingReads.push(entry);
		send({ id: opts.id ?? `read-${readSeq++}`, type: "prompt", message: `/agentkit-status ${area}` });
	});

const readPayload = async (area) => {
	const { payload } = await statusRead(area);
	if (!payload) throw new Error(`no payload for ${area}`);
	return payload;
};

const pollRead = async (area, predicate, timeoutMs) => {
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < timeoutMs) {
		try {
			last = await readPayload(area);
			if (predicate(last)) return last;
		} catch {
			/* transient */
		}
		await sleep(1500);
	}
	return last;
};

/** Block until the main agent is fully settled (a plain prompt sent mid-stream is rejected). */
const waitIdle = async (timeoutMs = 120000) => {
	const t0 = Date.now();
	while (!agentSettled && Date.now() - t0 < timeoutMs) await sleep(500);
	return agentSettled;
};

/** Prompt Main (a real model turn; the response is the RPC acceptance). */
const promptToMain = async (message) => {
	for (let attempt = 0; ; attempt++) {
		await waitIdle();
		const id = `main-${readSeq++}`;
		const w = waitForResponse(id, 30000);
		send({ id, type: "prompt", message });
		const resp = await w;
		if (resp.success !== false) return resp;
		if (attempt >= 4) throw new Error(`prompt rejected: ${JSON.stringify(resp).slice(0, 200)}`);
		await sleep(3000);
	}
};

const lastAssistantText = async () => {
	const id = `last-text-${readSeq++}`;
	const w = waitForResponse(id, 10000);
	send({ id, type: "get_last_assistant_text" });
	const resp = await w;
	return resp.data?.text ?? "";
};

// --- bring-up ----------------------------------------------------------------
const state = await getState();
if (!state) {
	console.log("FAIL  main pi process did not come up");
	main.kill();
	process.exit(1);
}
console.log(`-- main model: ${state.model.provider}/${state.model.id}`);

// --- S1: discovery -----------------------------------------------------------
{
	const w = waitForResponse("cmds", 10000);
	send({ id: "cmds", type: "get_commands" });
	const resp = await w;
	const cmd = (resp.data?.commands ?? []).find((c) => c.name === "agentkit-status");
	check("S1/T1 get_commands discovers agentkit-status", !!cmd, JSON.stringify(cmd ?? resp.data).slice(0, 120));
}

// --- S2: task area, model-free -----------------------------------------------
{
	const payload = await readPayload("task");
	const task = payload.data?.task ?? {};
	check(
		"S2/T2 task area → structured task state",
		payload.v === 1 && payload.area === "task"
			&& typeof task.classification === "string" && task.taskRoot === fs.realpathSync(TASK_ROOT)
			&& Array.isArray(task.taskWorkspaces),
		JSON.stringify(payload).slice(0, 160),
	);
	check("S2/T2 reads start no agent turn", mainAgentStarts === 0, `agent_starts=${mainAgentStarts}`);
}

// --- S3: subagents area before the first spawn --------------------------------
{
	const payload = await readPayload("subagents");
	check(
		"S3/T3 subagents before spawn → empty list, model-free",
		payload.v === 1 && payload.area === "subagents" && Array.isArray(payload.data?.agents)
			&& payload.data.agents.length === 0 && mainAgentStarts === 0,
		JSON.stringify(payload).slice(0, 120),
	);
}

// --- S4/S5: all area, unknown area, cancelled answers --------------------------
{
	const all = await readPayload("all");
	check(
		"S4 all area carries both keys",
		all.area === "all" && Array.isArray(all.data?.agents) && all.data?.task?.taskRoot !== undefined,
		JSON.stringify(all).slice(0, 120),
	);
	const bad = await readPayload("bogus");
	check(
		"S4/S5 unknown area → error payload over the same dialog path",
		bad.v === 1 && bad.area === "bogus" && typeof bad.error === "string" && bad.data === undefined,
		JSON.stringify(bad).slice(0, 120),
	);
	check("S5 cancelled:true answers complete every read", mainAgentStarts === 0, `agent_starts=${mainAgentStarts}`);
}

// --- S6: no controller answer → fail-closed -----------------------------------
{
	const t0 = Date.now();
	const dialogP = statusRead("task", { answer: false, dialogTimeoutMs: 45000, id: "read-timeout" });
	const respP = waitForResponse("read-timeout", 60000);
	const { request } = await dialogP;
	const timeoutOk = request.timeout === 15000;
	const resp = await respP;
	const elapsed = Date.now() - t0;
	check("S6/T7 dialog carries timeout 15000", timeoutOk, `timeout=${request.timeout}`);
	check(
		"S6/T7 no controller → read terminates fail-closed (success, ~15 s)",
		resp.success === true && elapsed >= 13500 && elapsed <= 30000,
		`elapsed=${elapsed}ms success=${resp.success}`,
	);
}
const agentStartsBeforeS7 = mainAgentStarts;

// --- S7: live plain subagent (spawned by Main through the real tool) ------------
{
	await promptToMain(
		'Use the subagent tool with op=spawn to start a background child: task="Use bash to run exactly: sleep 6. Then reply with exactly: STATUS-PLAIN-OK", label="status-plain". Do not wait for it.',
	);
	const running = await pollRead(
		"subagents",
		(p) => (p.data?.agents ?? []).some((a) => a.label === "status-plain" && a.state === "running"),
		90000,
	);
	const runningAgent = running?.data?.agents.find((a) => a.label === "status-plain");
	let pidAlive = false;
	if (runningAgent?.pid) {
		try {
			process.kill(runningAgent.pid, 0);
			pidAlive = true;
		} catch {
			pidAlive = false;
		}
	}
	check(
		"S7/T4 live running state is structured (pid alive, model, state)",
		!!runningAgent && typeof runningAgent.pid === "number" && pidAlive
			&& typeof runningAgent.model === "string" && runningAgent.alive === true,
		JSON.stringify(runningAgent ?? {}).slice(0, 200),
	);
	const done = await pollRead(
		"subagents",
		(p) => (p.data?.agents ?? []).some((a) => a.label === "status-plain" && a.state === "completed"),
		120000,
	);
	const doneAgent = done?.data?.agents.find((a) => a.label === "status-plain");
	check(
		"S7/T4 settles to completed in the payload",
		!!doneAgent && doneAgent.state === "completed",
		JSON.stringify(doneAgent ?? {}).slice(0, 160),
	);
}

// --- S8: live workspace (RepoOwner) run -----------------------------------------
let wsAgentId = null;
{
	const seed = path.join(LIVE, "seed");
	execSync(`git init -q -b main "${seed}"`);
	execSync(`git -C "${seed}" config user.email live@example.invalid`);
	execSync(`git -C "${seed}" config user.name "Live"`);
	fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
	execSync(`git -C "${seed}" add README.md`);
	execSync(`git -C "${seed}" commit -qm init`);
	const WS = path.join(TASK_ROOT, "status-ws");
	execSync(`git -C "${seed}" worktree add -b feat/status-ws "${WS}" main`);
	// Short, literal phrasing: long nested-quote prompts stall small flash
	// models in endless thinking, which looks exactly like a missing spawn.
	// Enumerate the exact tool arguments up front ("call X with op ..." phrasing
	// makes flash models emit arguments without op → tool validation error), and
	// keep the child busy ~20 s so the non-terminal window outlives Main's
	// thinking time and the poll reliably catches the run view.
	// promptToMain waits for idle first: the S7 turn may still be streaming when
	// the settle poll returns, and pi rejects a plain prompt sent mid-stream.
	await promptToMain(
		`Use the subagent tool once: op=spawn, workspace="${WS}", `
		+ `task='Run bash: sleep 20. Then call report_result with status done, summary STATUS-WS-OK.' Do nothing else.`,
	);

	// While the workspace spawn call is still blocked (Main is streaming), a
	// read must show the non-terminal run view.
	const during = await pollRead(
		"subagents",
		(p) => (p.data?.agents ?? []).some((a) => a.run && a.run.workspace && a.run.status === undefined),
		90000,
	);
	const liveRun = during?.data?.agents.find((a) => a.run && a.run.status === undefined);
	wsAgentId = liveRun?.id ?? null;
	check(
		"S8/T5 blocked workspace spawn → non-terminal run view (workspace, state, deadlineMsLeft)",
		!!liveRun && liveRun.run.workspace === fs.realpathSync(WS) && typeof liveRun.run.deadlineMsLeft === "number"
			&& liveRun.run.deadlineMsLeft > 0 && typeof liveRun.run.state === "string",
		JSON.stringify(liveRun ?? during ?? {}).slice(0, 240),
	);

	const settled = await pollRead(
		"subagents",
		(p) => (p.data?.agents ?? []).some((a) => a.id === wsAgentId && typeof a.run?.status === "string"),
		300000,
	);
	const settledAgent = settled?.data?.agents.find((a) => a.id === wsAgentId);
	check(
		"S8/T5 settled run exposes terminal status in the payload",
		settledAgent?.run?.status === "done",
		JSON.stringify(settledAgent ?? {}).slice(0, 200),
	);

	// --- S9: subagent op=status returns the same run view (no drift) ----------
	if (settledAgent?.run?.status === "done") {
		// op=status shows the model formatSnapshot text only (details go to the
		// UI), and that text carries the agent state and the run line's
		// "state <x>" but no terminal run.status — so compare the observable
		// fields against the command payload; run.status parity on the command
		// side is asserted by the settled check above and the agentDetailView
		// unit tests (one shared mapping).
		await promptToMain(
			`Call the subagent tool with op "status" and id "${wsAgentId}". `
			+ `Then reply with exactly one line and nothing else: RUN=<the agent's state> RUNSTATE=<the state word shown on the run: line>`,
		);
		let text = "";
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {
			await sleep(3000);
			try {
				text = await lastAssistantText();
			} catch {
				continue;
			}
			if (/RUN=\S+ RUNSTATE=\S+/.test(text)) break;
		}
		const m = text.match(/RUN=(\S+) RUNSTATE=(\S+)/);
		check(
			"S9/T6 subagent op=status reports the same run view as the command",
			!!m && m[1] === settledAgent.state && m[2] === settledAgent.run.state,
			`text=${JSON.stringify(text).slice(0, 160)} payload=${JSON.stringify(settledAgent.run)}`,
		);
	}
}

// --- final: the model-free reads stayed model-free -------------------------------
check(
	"the model-free reads (S1–S6) started no main agent turn",
	agentStartsBeforeS7 === 0,
	`agent_starts=${agentStartsBeforeS7} titles=${[...dialogTitles].join(",")}`,
);
check("no user-path dialog ever appeared (only agentkit:status)", !dialogTitles.has("ask"), [...dialogTitles].join(","));

main.kill();
const failed = results.filter((r) => !r.ok);
console.log(`-- status live verify: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
