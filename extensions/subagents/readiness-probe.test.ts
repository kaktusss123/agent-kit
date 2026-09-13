/**
 * Unit tests for the readiness probe (SPEC R2/R3.3): the child-side observer
 * entry that replaced per-extension signalChildReadiness calls. It reads the
 * session tool set once in session_start and emits the existing
 * fire-and-forget per-entry notifies with the exact payload shape
 * {protocol, entry, ok, tools, missing} for every entry of the profile
 * contract it imports (PROFILE_READINESS) — and for nothing else.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROFILE_READINESS, READINESS_PROTOCOL, type ReadinessPayload } from "./readiness";

interface ProbeHarness {
	sessionStartHandler: ((event: unknown, ctx: {
		ui: { notify(message: string, notifyType?: "info" | "warning" | "error"): void };
	}) => unknown) | undefined;
	notifies: Array<{ message: string; type?: string }>;
	run(): void;
}

function makeProbe(getAllTools: () => Array<{ name: string }>): ProbeHarness {
	const h: ProbeHarness = { sessionStartHandler: undefined, notifies: [], run: () => {} };
	const pi = {
		on: (event: string, cb: ProbeHarness["sessionStartHandler"]) => {
			if (event === "session_start") h.sessionStartHandler = cb;
		},
		getAllTools,
	} as unknown as ExtensionAPI;
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const factory = require("./readiness-probe.ts").default as (pi: ExtensionAPI) => void;
	factory(pi);
	h.run = () => {
		h.sessionStartHandler?.({ type: "session_start", reason: "startup" }, {
			ui: {
				notify: (message: string, type?: string) => {
					h.notifies.push({ message, type });
				},
			},
		});
	};
	return h;
}

const payloads = (h: ProbeHarness): ReadinessPayload[] =>
	h.notifies.map((n) => JSON.parse(n.message) as ReadinessPayload);

describe("readiness probe", () => {
	test("is a pure observer: registers no tools and no tool_call hooks", () => {
		const registered: string[] = [];
		const hooks: string[] = [];
		const pi = {
			registerTool: (def: { name: string }) => registered.push(def.name),
			on: (event: string) => {
				if (event === "tool_call") hooks.push(event);
			},
			getAllTools: () => [],
		} as unknown as ExtensionAPI;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		(require("./readiness-probe.ts").default as (pi: ExtensionAPI) => void)(pi);
		expect(registered).toEqual([]);
		expect(hooks).toEqual([]);
	});

	test("emits exactly one notify per contract entry, payload shape unchanged", () => {
		const h = makeProbe(() =>
			["ask", "report_result", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"].map((name) => ({ name })),
		);
		expect(h.sessionStartHandler).toBeDefined(); // profiled children only: this entry is never loaded elsewhere
		h.run();
		expect(h.notifies.map((n) => n.type)).toEqual(["info", "info"]);
		const ps = payloads(h);
		expect(ps.map((p) => p.entry).sort()).toEqual(Object.keys(PROFILE_READINESS).sort());
		for (const p of ps) {
			expect(Object.keys(p).sort()).toEqual(["entry", "missing", "ok", "protocol", "tools"]);
			expect(p.protocol).toBe(READINESS_PROTOCOL);
			expect(p.ok).toBe(true);
			expect(p.missing).toEqual([]);
		}
		const tw = ps.find((p) => p.entry === "task-workspace")!;
		expect(tw.tools).toContain("task_status");
	});

	test("partial registration reports ok:false with exactly the missing tools", () => {
		const h = makeProbe(() => ["ask", "task_status", "report_result"].map((name) => ({ name })));
		h.run();
		const ps = payloads(h);
		const tw = ps.find((p) => p.entry === "task-workspace")!;
		expect(tw.ok).toBe(false);
		expect(tw.missing).toEqual(["ensure_task_repo", "checkpoint_commit", "remove_task_lane"]);
		const rb = ps.find((p) => p.entry === "workspace-reporting")!;
		expect(rb.ok).toBe(true);
		expect(rb.missing).toEqual([]);
	});

	test("getAllTools failure reports ok:false for every entry (nothing can be proven)", () => {
		const h = makeProbe(() => {
			throw new Error("tool registry unavailable");
		});
		h.run();
		const ps = payloads(h);
		expect(ps).toHaveLength(Object.keys(PROFILE_READINESS).length);
		for (const p of ps) {
			expect(p.ok).toBe(false);
			expect(p.tools).toEqual([]);
			expect(p.missing).toEqual(PROFILE_READINESS[p.entry]);
		}
	});

	test("notify failure never breaks child startup (fire-and-forget contract)", () => {
		const h = makeProbe(() => ["task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane", "report_result"].map((name) => ({ name })));
		// Replace the capturing run with a throwing ui.
		let threw = false;
		try {
			h.sessionStartHandler?.({ type: "session_start", reason: "startup" }, {
				ui: {
					notify: () => {
						throw new Error("stdout gone");
					},
				},
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});
