// Live integration smoke for /model-class against a real pi process (SPEC §10):
//
//   current model A -> /model-class smart -> current model B
//   -> /model-class -> default reports B
//
// plus the subagent modelClass boundary through the real `subagent` tool
// (driven by the main model over RPC): modelClass=default spawns on the
// current Main pair, modelClass=smart on the stored pair, and an unset
// modelClass=cheap fails the op without starting a child. Also the negative
// command paths: activating an unset class and invalid syntax leave the
// session unchanged.
//
// Usage: node model-class-verify.mjs   (PI_BIN overrides the pi binary)
// The user's model-classes.json is backed up and restored on EVERY way out
// (normal exit, check failure, skip, SIGINT/SIGTERM); the session is
// ephemeral (--no-session).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_BIN = process.env.PI_BIN ?? "pi";
// The smoke needs BOTH extensions: model-classes for the commands and
// subagents for the tool-level modelClass boundary section below.
const EXT = [
	new URL("../index.ts", import.meta.url).pathname,
	new URL("../../subagents/index.ts", import.meta.url).pathname,
];
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const STORAGE = path.join(AGENT_DIR, "model-classes.json");

const EXTENDED = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function supportedLevels(model) {
	if (!model.reasoning) return ["off"];
	return EXTENDED.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

// --- storage backup/restore: the smoke owns model-classes.json while running.
// No process.exit may happen while storageOwned is true — Node skips finally
// blocks on process.exit, so every exit path must go through restoreStorage().
const backup = fs.existsSync(STORAGE) ? fs.readFileSync(STORAGE, "utf8") : null;
let storageOwned = true;
function restoreStorage() {
	if (!storageOwned) return;
	storageOwned = false;
	if (backup !== null) fs.writeFileSync(STORAGE, backup);
	else fs.rmSync(STORAGE, { force: true });
}
fs.rmSync(STORAGE, { force: true }); // deterministic start: cheap/smart unset

const main = spawn(PI_BIN, [
	"--mode", "rpc", "--no-session",
	"--no-extensions", // discovery would double-load the installed copies of these same extensions
	...EXT.flatMap((e) => ["-e", e]),
], {
	cwd: fs.mkdtempSync(path.join(os.tmpdir(), "model-class-smoke-")),
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
});
function killMain() {
	try {
		main.kill("SIGTERM");
	} catch {}
}
process.on("SIGINT", () => {
	restoreStorage();
	killMain();
	process.exit(130);
});
process.on("SIGTERM", () => {
	restoreStorage();
	killMain();
	process.exit(143);
});
process.on("exit", restoreStorage);

let buf = "";
const notifies = [];
const toolEvents = []; // subagent tool calls: { op, isError, text, snapshotModel, snapshotLabel }
let settled = true; // agent_settled tracking for sequential prompt driving
let lastAssistantText = "";
const pending = new Map();
const send = (cmd) => {
	main.stdin.write(JSON.stringify(cmd) + "\n");
};
const request = (cmd) =>
	new Promise((resolve, reject) => {
		const id = `smoke-${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timeout waiting for ${cmd.type}`));
		}, 20000);
		pending.set(id, { resolve, timer });
		send({ ...cmd, id });
	});
/** Request that fails loudly when pi rejects the command itself. */
const requestOk = async (cmd) => {
	const resp = await request(cmd);
	if (resp.success !== true) throw new Error(`${cmd.type} rejected: ${JSON.stringify(resp.error ?? resp.data ?? resp)}`);
	return resp;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drainNotifies() {
	await sleep(300); // fire-and-forget notifications arrive asynchronously
	return notifies.splice(0);
}
async function waitFor(pred, timeoutMs) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return true;
		await sleep(500);
	}
	return pred();
}
// Send one prompt and wait for the model turn to fully settle, so the next
// prompt never races a streaming agent.
async function promptAndSettle(message) {
	settled = false;
	await requestOk({ type: "prompt", message });
	if (!(await waitFor(() => settled, 120000))) throw new Error("model turn did not settle in time");
}

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
		if (ev.type === "response" && ev.id && pending.has(ev.id)) {
			const { resolve, timer } = pending.get(ev.id);
			clearTimeout(timer);
			pending.delete(ev.id);
			resolve(ev);
		}
		if (ev.type === "extension_ui_request" && ev.method === "notify") {
			console.log(`[notify:${ev.notifyType ?? "info"}] ${String(ev.message).split("\n")[0]}`);
			notifies.push({ type: ev.notifyType ?? "info", message: String(ev.message) });
		}
		if (ev.type === "agent_start") settled = false;
		if (ev.type === "agent_settled") {
			settled = true;
			console.log(`[turn settled] ${lastAssistantText.slice(0, 160).replace(/\n/g, " | ")}`);
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			lastAssistantText = (ev.message.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join(" ");
		}
		if (ev.type === "tool_execution_start" && ev.toolName === "subagent") {
			toolEvents.push({ op: ev.args?.op, label: ev.args?.label, modelClass: ev.args?.modelClass });
		}
		if (ev.type === "tool_execution_end" && ev.toolName === "subagent") {
			const text = (ev.result?.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join(" ");
			const last = toolEvents[toolEvents.length - 1];
			if (last) {
				// RPC marks error results inconsistently (event flag, result flag,
				// or the subagent tool's details.error) — treat any as an error.
				last.isError = ev.isError === true || ev.result?.isError === true || ev.result?.details?.error !== undefined;
				last.text = text;
				last.snapshotModel = ev.result?.details?.snapshot?.model;
				last.snapshotLabel = ev.result?.details?.snapshot?.label;
			}
			console.log(`[subagent op=${last?.op} label=${last?.label}] isError=${last?.isError} -> ${String(last?.text ?? "").slice(0, 90).replace(/\n/g, " | ")}`);
		}
	}
});
main.stderr.on("data", () => {});

const checks = [];
const check = (name, ok, detail = "") => {
	checks.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
};

async function getState() {
	const resp = await request({ type: "get_state" });
	return { model: resp.data?.model, thinking: resp.data?.thinkingLevel, provider: resp.data?.model?.provider, id: resp.data?.model?.id };
}

function findEvent(label) {
	return toolEvents.find((t) => t.label === label);
}

// Drives the real `subagent` tool through the modelClass boundary contract:
// one instruction per turn (deterministic), waiting for the spawn ack each
// time. Children reply with a single word and are shut down with the main
// process (session_shutdown cancels all owned children).
async function runSubagentBoundary() {
	await promptAndSettle(
		// Deliberately NO modelClass in this call: the omitted form must spawn
		// exactly like "default" (on the current Main pair).
		'Use the subagent tool once right now: op=spawn, label=mc-default, task="Reply with the single word OK." Then briefly confirm the spawned id.',
	);
	const defaultSeen = await waitFor(() => findEvent("mc-default")?.text !== undefined, 60000);
	if (!defaultSeen) console.log(`[warn] mc-default tool call not observed; last: ${lastAssistantText.slice(0, 200)}`);

	await promptAndSettle(
		'Use the subagent tool once right now: op=spawn, modelClass=smart, label=mc-smart, task="Reply with the single word OK." Then briefly confirm the spawned id.',
	);
	await waitFor(() => findEvent("mc-smart")?.text !== undefined, 60000);

	await promptAndSettle(
		'Use the subagent tool once right now: op=spawn, modelClass=cheap, label=mc-cheap, task="Reply OK." The call is expected to fail — do NOT retry it; just confirm the failure.',
	);
	await waitFor(() => findEvent("mc-cheap")?.text !== undefined, 60000);
	return toolEvents;
}

let outcome = "pass";
let skipReason = "";
try {
	// Arrange: two distinct, actually applicable models (auth can make a
	// listed model unswitchable — verify each candidate with set_model).
	const avail = await request({ type: "get_available_models" });
	const models = avail.data?.models ?? [];
	const stateA0 = await getState();
	const ref = (m) => `${m.provider}/${m.id}`;
	if (models.length < 2) {
		outcome = "skip";
		skipReason = `need >=2 available models, found ${models.length}`;
	} else {
		const modelA = models.find((m) => `${m.provider}/${m.id}` === `${stateA0.provider}/${stateA0.id}`) ?? models[0];
		const tryApply = async (model, level) => {
			try {
				await requestOk({ type: "set_model", provider: model.provider, modelId: model.id });
				await requestOk({ type: "set_thinking_level", level });
			} catch {
				return false;
			}
			const s = await getState();
			return `${s.provider}/${s.id}` === ref(model) && s.thinking === level;
		};

		let modelB = null;
		let levelB = null;
		for (const candidate of models.filter((m) => ref(m) !== ref(modelA))) {
			const levels = supportedLevels(candidate);
			const level = levels.includes("medium") ? "medium" : levels.at(-1);
			if (await tryApply(candidate, level)) {
				modelB = candidate;
				levelB = level;
				break;
			}
		}
		if (!modelB) {
			outcome = "skip";
			skipReason = "no second model with working auth (set_model failed for all candidates)";
		} else {
			const levelA = supportedLevels(modelA).includes("high") ? "high" : supportedLevels(modelA)[0];
			console.log(`models: A=${ref(modelA)} [${levelA}]  B=${ref(modelB)} [${levelB}]`);

			// Arrange A: make sure the session runs A/levelA. The candidate loop
			// above verified B by applying it; arrange A as the starting state.
			check("A is applicable", await tryApply(modelA, levelA));
			let s = await getState();
			check("session starts on A", ref(modelA) === `${s.provider}/${s.id}` && s.thinking === levelA, JSON.stringify(s));

			// 1. Switch the session to B, then save smart = B while B is current.
			check("B is applicable", await tryApply(modelB, levelB));
			await request({ type: "prompt", message: "/model-class smart set" });
			const savedNotes = await drainNotifies();
			check(
				"smart set reports the saved pair",
				savedNotes.some((n) => n.type === "info" && n.message === `Saved smart: ${ref(modelB)}, ${levelB}`),
				JSON.stringify(savedNotes),
			);
			s = await getState();
			check("set does not change the session (A2)", `${s.provider}/${s.id}` === ref(modelB) && s.thinking === levelB, JSON.stringify(s));

			// 2. Back to A. Keep the session here for the subagent section: the
			// main-model turn that drives the tool needs a known-good LLM, and
			// default→A vs smart→B give distinguishable expectations.
			check("back to A after saving smart", await tryApply(modelA, levelA));

			// 3. Subagent modelClass boundary through the real tool.
			// Precondition: session runs A, smart = B, cheap is unset.
			const events = await runSubagentBoundary();
			const defSpawn = events.find((t) => t.label === "mc-default");
			const smartSpawn = events.find((t) => t.label === "mc-smart");
			const cheapSpawn = events.find((t) => t.label === "mc-cheap");
			check("subagent default ran (A10; omitted modelClass = default)", !!defSpawn && !defSpawn.isError, JSON.stringify(events.map(({ op, label, isError }) => ({ op, label, isError }))));
			check(
				"omitted modelClass spawned on the current Main pair",
				!!defSpawn && defSpawn.snapshotModel === ref(modelA),
				`snapshot.model=${defSpawn?.snapshotModel} expected=${ref(modelA)}`,
			);
			check(
				"modelClass=smart spawned on the stored pair, not Main's (A11)",
				!!smartSpawn && !smartSpawn.isError && smartSpawn.snapshotModel === ref(modelB),
				`snapshot.model=${smartSpawn?.snapshotModel} expected=${ref(modelB)}`,
			);
			check(
				"unset cheap fails the spawn op with the spec error (A7)",
				!!cheapSpawn && cheapSpawn.isError && cheapSpawn.text.includes('Model class "cheap" is not saved'),
				JSON.stringify(cheapSpawn?.text?.slice(0, 160)),
			);
			check(
				"failed cheap spawn started no child",
				events.every((t) => t.label !== "mc-cheap" || t.snapshotModel === undefined),
			);

			// 4. Switch to smart: the session becomes B, status shows default = B.
			await request({ type: "prompt", message: "/model-class smart" });
			const switchNotes = await drainNotifies();
			check(
				"switch reports the applied pair",
				switchNotes.some((n) => n.type === "info" && n.message === `Switched to smart: ${ref(modelB)}, ${levelB}`),
				JSON.stringify(switchNotes),
			);
			s = await getState();
			check(
				"session now runs B (model AND thinking, no partial state)",
				`${s.provider}/${s.id}` === ref(modelB) && s.thinking === levelB,
				JSON.stringify(s),
			);

			// 3. Status: default reports B (dynamic default), smart row equal.
			await request({ type: "prompt", message: "/model-class" });
			const statusNotes = await drainNotifies();
			const status = statusNotes.find((n) => n.message.startsWith("Model classes"))?.message ?? "";
			const statusLines = status.split("\n");
			const defLine = statusLines.find((l) => l.startsWith("default"));
			const smartLine = statusLines.find((l) => l.startsWith("smart"));
			check("status shows default = B (A9 via command surface)", !!defLine && defLine.includes(ref(modelB)) && defLine.includes(levelB), status);
			check("status shows smart = B, no active-class marker", !!smartLine && smartLine.includes(ref(modelB)) && !status.includes("*"), status);

			// 5. Negative: cheap via the command as well; session unchanged.
			await request({ type: "prompt", message: "/model-class cheap" });
			const errNotes = await drainNotifies();
			check(
				"unset cheap fails with the spec error",
				errNotes.some((n) => n.type === "error" && n.message.includes('Model class "cheap" is not saved')),
				JSON.stringify(errNotes),
			);
			s = await getState();
			check("failed switch leaves the session on B", `${s.provider}/${s.id}` === ref(modelB) && s.thinking === levelB, JSON.stringify(s));

			// 6. Invalid syntax: error + usage, no state change (SPEC §8).
			await request({ type: "prompt", message: "/model-class default set" });
			const badNotes = await drainNotifies();
			check(
				"invalid syntax errors with usage",
				badNotes.some((n) => n.type === "error" && n.message.includes("Usage:")),
				JSON.stringify(badNotes),
			);
		}
	}
} catch (e) {
	check("smoke completed", false, e.message);
} finally {
	// Every exit path flows through here — never process.exit() above.
	restoreStorage();
	killMain();
}

if (outcome === "skip") {
	console.log(`SKIP: ${skipReason}`);
	process.exit(2);
}
const failed = checks.filter((c) => !c).length;
console.log(`\n== RESULT == ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
