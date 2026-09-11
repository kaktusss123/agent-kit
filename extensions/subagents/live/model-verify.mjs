// Model-level integration check: a real main model drives the production
// `subagent` tool end-to-end (spawn -> status/wait -> result).
import { spawn } from "node:child_process";
import * as fs from "node:fs";

// PI_BIN override: path to a pi executable (bin shim or cli.js bundle).
const PI_BIN = process.env.PI_BIN ?? "pi";
const EXT = new URL("../index.ts", import.meta.url).pathname;
const WORKDIR = "/tmp/pi-subagents-model";

fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.mkdirSync(WORKDIR, { recursive: true });

const main = spawn(PI_BIN, ["--mode", "rpc", "--no-session", "-e", EXT], {
	cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const toolCalls = [];
let finalText = "";
const send = (cmd) => main.stdin.write(JSON.stringify(cmd) + "\n");

main.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "tool_execution_start" && ev.toolName === "subagent") {
			toolCalls.push({ args: ev.args, ok: true, text: "" });
			console.log(`[probe] subagent call op=${ev.args?.op}`);
		}
		if (ev.type === "tool_execution_end" && ev.toolName === "subagent") {
			const text = (ev.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
			toolCalls.push({ args: ev.args, ok: !ev.isError, text: text.slice(0, 100) });
			console.log(`[probe] subagent op=${ev.args?.op} isError=${ev.isError} -> ${text.slice(0, 90).replace(/\n/g, " | ")}`);
		}
		if (ev.type === "agent_settled") {
			send({ id: `last-${Date.now()}`, type: "get_last_assistant_text" });
		}
		if (ev.type === "response" && ev.command === "get_last_assistant_text" && ev.success) {
			finalText = ev.data?.text ?? "";
			console.log("[probe] final:", JSON.stringify(finalText.slice(0, 250)));
			finish();
		}
	}
});
main.stderr.on("data", () => {});

function finish() {
	console.log("\n== RESULT ==");
	const ops = toolCalls.map((t) => t.args?.op);
	console.log("subagent tool calls:", ops.join(",") || "(none)");
	const ok =
		toolCalls.length >= 2 &&
		ops.includes("spawn") &&
		(ops.includes("wait") || ops.includes("status") || ops.includes("result")) &&
		finalText.includes("SCOUT-REPORT-OK");
	console.log(ok ? "MODEL INTEGRATION: PASS" : "MODEL INTEGRATION: FAIL");
	main.kill("SIGTERM");
	setTimeout(() => process.exit(ok ? 0 : 1), 500);
}

setTimeout(() => {
	send({
		id: "p1",
		type: "prompt",
		message:
			"Delegate a task to a subagent: spawn one labeled 'scout' with the task \"Use bash to run: echo hello-from-scout. Then reply with exactly: SCOUT-REPORT-OK\". " +
			"While it works, do nothing else. Then wait for it to finish and report its exact final text and its session file path in your reply.",
	});
}, 400);

setTimeout(() => { console.log("[probe] TIMEOUT"); main.kill("SIGKILL"); process.exit(1); }, 240000);
