/**
 * Eager-registration probe helper: records the registered tool names at
 * session_start, before any prompt is received. Loaded alongside the shipped
 * subagents extension to prove workspace_agent is registered eagerly (F1).
 */
import * as fs from "node:fs";

const OUT = "/tmp/pi-eager-probe/tools.json";

export default function (pi: {
	on(event: "session_start", handler: (event: unknown, ctx: unknown) => unknown): unknown;
	getAllTools(): Array<{ name: string }>;
}) {
	pi.on("session_start", () => {
		try {
			fs.mkdirSync("/tmp/pi-eager-probe", { recursive: true });
			fs.writeFileSync(OUT, JSON.stringify({ tools: pi.getAllTools().map((t) => t.name) }));
		} catch {
			// probe only
		}
	});
}
