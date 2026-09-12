// Live integration smoke for /model-class against a real pi process (SPEC §10):
//
//   current model A -> /model-class smart -> current model B
//   -> /model-class -> default reports B
//
// plus the negative path: activating an unset class fails and leaves the
// session unchanged. Drives the production extension over the RPC protocol:
// `prompt "/model-class ..."` executes the extension command, notifications
// arrive as fire-and-forget extension_ui_request events, and `get_state` /
// `get_available_models` / `set_model` / `set_thinking_level` observe and
// arrange the session.
//
// Usage: node model-class-verify.mjs   (PI_BIN overrides the pi binary)
// The user's model-classes.json is backed up and restored; the session is
// ephemeral (--no-session) and no LLM call is made.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PI_BIN = process.env.PI_BIN ?? "pi";
const EXT = new URL("../index.ts", import.meta.url).pathname;
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

// --- storage backup/restore: the smoke owns model-classes.json while running
const backup = fs.existsSync(STORAGE) ? fs.readFileSync(STORAGE, "utf8") : null;
fs.rmSync(STORAGE, { force: true });

const main = spawn(PI_BIN, ["--mode", "rpc", "--no-session", "-e", EXT], {
	cwd: fs.mkdtempSync(path.join(os.tmpdir(), "model-class-smoke-")),
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
});

let buf = "";
const notifies = [];
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

try {
	// Arrange: two distinct, actually applicable models (auth can make a
	// listed model unswitchable — verify each candidate with set_model).
	const avail = await request({ type: "get_available_models" });
	const models = avail.data?.models ?? [];
	if (models.length < 2) {
		console.log(`SKIP: need >=2 available models, found ${models.length}`);
		process.exit(2);
	}
	const stateA0 = await getState();
	const modelA = models.find((m) => `${m.provider}/${m.id}` === `${stateA0.provider}/${stateA0.id}`) ?? models[0];
	const ref = (m) => `${m.provider}/${m.id}`;
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
		console.log("SKIP: no second model with working auth (set_model failed for all candidates)");
		process.exit(2);
	}
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

	// 2. Back to A, then switch to smart.
	check("back to A after saving smart", await tryApply(modelA, levelA));
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

	// 4. Negative: cheap is unset -> error, session unchanged (A7).
	await request({ type: "prompt", message: "/model-class cheap" });
	const errNotes = await drainNotifies();
	check(
		"unset cheap fails with the spec error",
		errNotes.some((n) => n.type === "error" && n.message.includes('Model class "cheap" is not configured')),
		JSON.stringify(errNotes),
	);
	s = await getState();
	check("failed switch leaves the session on B", `${s.provider}/${s.id}` === ref(modelB) && s.thinking === levelB, JSON.stringify(s));

	// 5. Invalid syntax: error + usage, no state change (SPEC §8).
	await request({ type: "prompt", message: "/model-class default set" });
	const badNotes = await drainNotifies();
	check(
		"invalid syntax errors with usage",
		badNotes.some((n) => n.type === "error" && n.message.includes("Usage:")),
		JSON.stringify(badNotes),
	);
} catch (e) {
	check("smoke completed", false, e.message);
} finally {
	main.kill("SIGTERM");
	if (backup !== null) fs.writeFileSync(STORAGE, backup);
	else fs.rmSync(STORAGE, { force: true });
}
const failed = checks.filter((c) => !c).length;
console.log(`\n== RESULT == ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
