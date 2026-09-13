/**
 * F1 probe: workspace_agent must be registered in a fresh session WITHOUT
 * any prior subagent tool call. Spawns a real main pi process with the
 * shipped extension index plus a tool-recording probe, sends NO prompt, and
 * asserts the recorded tool set. Run: node eager-registration-probe.mjs
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_BIN = process.env.PI_BIN ?? "pi";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(DIR, "..", "index.ts");
const PROBE = path.join(DIR, "eager-probe-helper.ts");
const OUT = "/tmp/pi-eager-probe/tools.json";

fs.rmSync("/tmp/pi-eager-probe", { recursive: true, force: true });
fs.mkdirSync("/tmp/pi-eager-probe", { recursive: true });

const main = spawn(PI_BIN, ["--mode", "rpc", "--no-extensions", "-e", INDEX, "-e", PROBE], {
	cwd: "/tmp",
	stdio: ["pipe", "pipe", "ignore"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = false;
let detail = "";
for (let i = 0; i < 60; i++) {
	await sleep(500);
	try {
		const data = JSON.parse(fs.readFileSync(OUT, "utf8"));
		const names = data.tools ?? [];
		if (names.length > 0) {
			ok = names.includes("workspace_agent") && names.includes("subagent");
			detail = `workspace_agent=${names.includes("workspace_agent")} subagent=${names.includes("subagent")} total=${names.length}`;
			break;
		}
	} catch { /* not written yet */ }
}
main.kill();
console.log(`${ok ? "PASS" : "FAIL"}  F1 eager workspace_agent registration (no prior subagent call)  — ${detail || "probe produced no output"}`);
process.exit(ok ? 0 : 1);
