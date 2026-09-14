/**
 * Unit tests for the readiness probe: the child-side observer entry. The
 * probe owns NO contract of its own and receives none: at `session_start` it
 * reads the actual session tool set once and emits ONE fire-and-forget
 * notify with the exact payload shape {protocol, tools}. The controller
 * validates that report against its own per-spawn readiness contract and
 * fails the spawn closed on anything unsatisfiable.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { READINESS_PROTOCOL, parseReadinessPayload, type ReadinessPayload } from "./readiness";

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

	test("registers a session_start handler and emits exactly one notify with the observed tool set", () => {
		const h = makeProbe(() => ["ask", "report_result", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"].map((name) => ({ name })));
		expect(h.sessionStartHandler).toBeDefined();
		h.run();
		expect(h.notifies.map((n) => n.type)).toEqual(["info"]);
		const ps = payloads(h);
		expect(ps).toHaveLength(1);
		expect(Object.keys(ps[0]).sort()).toEqual(["protocol", "tools"]);
		expect(ps[0].protocol).toBe(READINESS_PROTOCOL);
		// the report is the observed session set — no contract-derived verdicts
		expect(ps[0].tools).toEqual(["ask", "report_result", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"]);
	});

	test("tool listing failure reports an empty set (controller fails closed, nothing proven)", () => {
		const h = makeProbe(() => {
			throw new Error("tool registry unavailable");
		});
		h.run();
		const ps = payloads(h);
		expect(ps).toHaveLength(1);
		expect(ps[0].tools).toEqual([]);
	});

	test("notify failure never breaks child startup (fire-and-forget contract)", () => {
		const h = makeProbe(() => ["task_status", "report_result"].map((name) => ({ name })));
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

describe("parseReadinessPayload", () => {
	test("accepts the {protocol, tools} report shape", () => {
		expect(parseReadinessPayload(undefined)).toBeUndefined();
		expect(parseReadinessPayload("not json")).toBeUndefined();
		expect(parseReadinessPayload(JSON.stringify({ protocol: READINESS_PROTOCOL }))).toBeUndefined();
		expect(parseReadinessPayload(JSON.stringify({ protocol: "other", tools: ["t"] }))).toBeUndefined();
		const good = parseReadinessPayload(JSON.stringify({ protocol: READINESS_PROTOCOL, tools: ["t", "u"] }));
		expect(good).toMatchObject({ protocol: READINESS_PROTOCOL, tools: ["t", "u"] });
	});
});
