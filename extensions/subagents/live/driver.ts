/**
 * Live-verification driver: runs the PRODUCTION LocalSubagentRuntime inside a
 * real main pi process and records an assertion log for the probe.
 *
 * Driven via extension commands (execute immediately even while main is
 * streaming). Not part of the shipped extension wiring.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LocalSubagentRuntime } from "../controller";
import { attachDelivery } from "../wiring";

interface LogEntry {
	at: number;
	kind: string;
	[key: string]: unknown;
}

export default function (pi: ExtensionAPI) {
	const log: LogEntry[] = [];
	let rt: LocalSubagentRuntime | null = null;
	let counter = 0;

	const entry = (kind: string, data: Record<string, unknown> = {}) => {
		log.push({ at: Date.now(), kind, ...data });
	};

	const runtime = (cwd: string): LocalSubagentRuntime => {
		if (!rt) {
			rt = new LocalSubagentRuntime({ defaultCwd: cwd });
			attachDelivery(pi, rt);
			rt.onEvent((ev) => entry("event", { ...ev }));
		}
		return rt;
	};

	pi.registerCommand("drv-log", {
		description: "Dump driver log as JSON",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`DRIVERLOG:${JSON.stringify(log)}`, "info");
		},
	});

	pi.registerCommand("drv-spawn", {
		description: "spawn <label> <durationSec> <finalMark> [ask] — spawn a scripted child",
		handler: async (args, ctx) => {
			const [label, durStr, mark, mode] = args.split(" ");
			const dur = parseInt(durStr || "8", 10);
			const r = runtime(ctx.cwd);
			const id = ++counter;
			const task =
				mode === "ask"
					? `Call the ask_parent tool with question 'What magic word should I use?' then wait for the answer. After receiving it, reply with exactly: ASKED-${mark}-ANSWERED`
					: `Use bash to run exactly: sleep ${dur}. Then reply with exactly: ${mark}`;
			const pending = r.spawn({ task, label: label || `drv-${id}` });
			pending
				.then((snap) => entry("spawned", { id: snap.id, label: snap.label, pid: snap.pid }))
				.catch((e) => entry("spawn-failed", { error: String(e) }));
			ctx.ui.notify(`drv: spawning ${label}`, "info");
		},
	});

	pi.registerCommand("drv-spawn-sync", {
		description: "spawn and measure acceptance latency",
		handler: async (args, ctx) => {
			const [label, durStr, mark] = args.split(" ");
			const dur = parseInt(durStr || "10", 10);
			const t0 = Date.now();
			const snap = await runtime(ctx.cwd).spawn({
				task: `Use bash to run exactly: sleep ${dur}. Then reply with exactly: ${mark}`,
				label,
			});
			entry("spawn-latency", { id: snap.id, ms: Date.now() - t0 });
			ctx.ui.notify(`drv: ${snap.id} accepted in ${Date.now() - t0}ms`, "info");
		},
	});

	pi.registerCommand("drv-steer", {
		description: "steer <label-or-id-prefix> <message>",
		handler: async (args, ctx) => {
			const [target, ...rest] = args.split(" ");
			const message = rest.join(" ");
			const r = runtime(ctx.cwd);
			const id = resolveId(r, target);
			await r.steer(id, message);
			entry("steered", { id, message });
			ctx.ui.notify(`drv: steered ${id}`, "info");
		},
	});

	pi.registerCommand("drv-followup", {
		description: "follow_up <label-or-id-prefix> <message>",
		handler: async (args, ctx) => {
			const [target, ...rest] = args.split(" ");
			const message = rest.join(" ");
			const r = runtime(ctx.cwd);
			const id = resolveId(r, target);
			await r.followUp(id, message);
			entry("followup", { id, message });
			ctx.ui.notify(`drv: follow_up ${id}`, "info");
		},
	});

	pi.registerCommand("drv-respond", {
		description: "respond <label-or-id-prefix> <answer>",
		handler: async (args, ctx) => {
			const [target, ...rest] = args.split(" ");
			const answer = rest.join(" ");
			const r = runtime(ctx.cwd);
			const id = resolveId(r, target);
			await r.respond(id, answer);
			entry("responded", { id, answer });
			ctx.ui.notify(`drv: responded to ${id}`, "info");
		},
	});

	pi.registerCommand("drv-cancel", {
		description: "cancel <label-or-id-prefix>",
		handler: async (args, ctx) => {
			const r = runtime(ctx.cwd);
			const id = resolveId(r, args.trim());
			const t0 = Date.now();
			await r.cancel(id);
			entry("cancel-done", { id, ms: Date.now() - t0 });
			ctx.ui.notify(`drv: cancelled ${id} in ${Date.now() - t0}ms`, "info");
		},
	});

	pi.registerCommand("drv-kill-pid", {
		description: "kill -9 <pid> — simulate a child crash",
		handler: async (args, ctx) => {
			const pid = parseInt(args.trim(), 10);
			try {
				process.kill(pid, "SIGKILL");
				entry("killed-pid", { pid });
				ctx.ui.notify(`drv: SIGKILLed ${pid}`, "info");
			} catch (e) {
				ctx.ui.notify(`drv: kill failed: ${String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("drv-result", {
		description: "result <label-or-id-prefix>",
		handler: async (args, ctx) => {
			const r = runtime(ctx.cwd);
			const id = resolveId(r, args.trim());
			const result = await r.result(id);
			entry("result", { id, result });
			ctx.ui.notify(result ? `drv: ${result.status}: ${result.finalText?.slice(0, 120)}` : `drv: no result yet for ${id}`, "info");
		},
	});

	pi.registerCommand("drv-wait", {
		description: "wait <label-or-id-prefix>",
		handler: async (args, ctx) => {
			const r = runtime(ctx.cwd);
			const id = resolveId(r, args.trim());
			const outcome = await r.wait(id, { timeoutMs: 120000 });
			entry("wait", { id, outcome });
			ctx.ui.notify(`drv: wait ${id} -> ${JSON.stringify(outcome)}`, "info");
		},
	});

	pi.registerCommand("drv-sessions", {
		description: "dump snapshots",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`DRIVERSNAP:${JSON.stringify(runtime(ctx.cwd).inspect())}`, "info");
		},
	});

	function resolveId(r: LocalSubagentRuntime, prefix: string): string {
		const all = r.inspect();
		const exact = all.find((s) => s.id === prefix);
		if (exact) return exact.id;
		const byPrefix = all.find((s) => s.id.startsWith(prefix));
		if (byPrefix) return byPrefix.id;
		const byLabel = all.find((s) => s.label === prefix);
		if (byLabel) return byLabel.id;
		throw new Error(`no agent matching ${prefix}`);
	}
}
