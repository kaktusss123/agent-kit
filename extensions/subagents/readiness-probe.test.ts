/**
 * Unit tests for the readiness probe (SPEC R2/R3.3): the child-side observer
 * entry that replaced per-extension signalChildReadiness calls. The probe
 * owns NO contract of its own: at registration it parses the per-spawn
 * contract from the PI_SUBAGENT_READINESS_CONTRACT env var (serialized by
 * the spawning controller) and registers its session_start handler only for
 * a valid contract. With one, it emits the fire-and-forget per-entry
 * notifies with the exact payload shape {protocol, entry, ok, tools,
 * missing} for exactly the declared entries — and nothing else; without a
 * valid one (missing / invalid JSON / wrong shape) it registers nothing
 * (fail closed; the controller-side readiness timeout fires).
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseReadinessContract,
	PROFILE_READINESS,
	READINESS_CONTRACT_ENV,
	READINESS_PROTOCOL,
	type ReadinessPayload,
} from "./readiness";

interface ProbeHarness {
	sessionStartHandler: ((event: unknown, ctx: {
		ui: { notify(message: string, notifyType?: "info" | "warning" | "error"): void };
	}) => unknown) | undefined;
	notifies: Array<{ message: string; type?: string }>;
	run(): void;
}

/**
 * Set the contract env for the duration of `run` (the probe parses the env
 * at registration, i.e. inside makeProbe) and restore it afterwards.
 */
function withContractEnv(raw: string | undefined, run: () => void): void {
	const prev = process.env[READINESS_CONTRACT_ENV];
	if (raw === undefined) delete process.env[READINESS_CONTRACT_ENV];
	else process.env[READINESS_CONTRACT_ENV] = raw;
	try {
		run();
	} finally {
		if (prev === undefined) delete process.env[READINESS_CONTRACT_ENV];
		else process.env[READINESS_CONTRACT_ENV] = prev;
	}
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
		withContractEnv(JSON.stringify(PROFILE_READINESS), () => {
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
	});

	test("reports exactly the per-spawn env contract — even when it differs from PROFILE_READINESS", () => {
		withContractEnv(JSON.stringify({ "custom-entry": ["toolA", "toolB"] }), () => {
			const h = makeProbe(() => ["ask", "toolA", "toolB"].map((name) => ({ name })));
			expect(h.sessionStartHandler).toBeDefined();
			h.run();
			const ps = payloads(h);
			expect(ps.map((p) => p.entry)).toEqual(["custom-entry"]); // nothing from PROFILE_READINESS
			expect(Object.keys(ps[0]).sort()).toEqual(["entry", "missing", "ok", "protocol", "tools"]);
			expect(ps[0].protocol).toBe(READINESS_PROTOCOL);
			expect(ps[0].ok).toBe(true);
			expect(ps[0].missing).toEqual([]);
			expect(ps[0].tools).toEqual(["ask", "toolA", "toolB"]);
		});
	});

	test("per-spawn contract: ok:false and missing computed from the declared tools only", () => {
		withContractEnv(JSON.stringify({ "custom-entry": ["toolA", "toolB", "toolC"] }), () => {
			const h = makeProbe(() => ["ask", "toolA"].map((name) => ({ name })));
			h.run();
			const ps = payloads(h);
			expect(ps.map((p) => p.entry)).toEqual(["custom-entry"]);
			expect(ps[0].ok).toBe(false);
			expect(ps[0].missing).toEqual(["toolB", "toolC"]);
		});
	});

	test("emits exactly one notify per declared contract entry, payload shape unchanged", () => {
		withContractEnv(JSON.stringify(PROFILE_READINESS), () => {
			const h = makeProbe(() =>
				["ask", "report_result", "task_status", "ensure_task_repo", "checkpoint_commit", "remove_task_lane"].map((name) => ({ name })),
			);
			expect(h.sessionStartHandler).toBeDefined(); // valid contract: handler registered
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
	});

	test("partial registration reports ok:false with exactly the missing tools", () => {
		withContractEnv(JSON.stringify(PROFILE_READINESS), () => {
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
	});

	test("getAllTools failure reports ok:false for every entry (nothing can be proven)", () => {
		withContractEnv(JSON.stringify(PROFILE_READINESS), () => {
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
	});

	test("notify failure never breaks child startup (fire-and-forget contract)", () => {
		withContractEnv(JSON.stringify(PROFILE_READINESS), () => {
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

	test("missing env contract registers no session_start handler (fail closed)", () => {
		withContractEnv(undefined, () => {
			const h = makeProbe(() => ["task_status", "report_result"].map((name) => ({ name })));
			expect(h.sessionStartHandler).toBeUndefined();
			h.run(); // inert: no notifies
			expect(h.notifies).toHaveLength(0);
		});
	});

	test("invalid JSON contract registers no session_start handler (fail closed)", () => {
		withContractEnv("not json", () => {
			const h = makeProbe(() => ["task_status", "report_result"].map((name) => ({ name })));
			expect(h.sessionStartHandler).toBeUndefined();
			expect(h.notifies).toHaveLength(0);
		});
	});

	test("wrong-shape contracts register no session_start handler (fail closed)", () => {
		for (const raw of [
			JSON.stringify(["task-workspace", "workspace-reporting"]), // array, not a plain object
			JSON.stringify({ "task-workspace": "task_status" }), // value not an array
			JSON.stringify({ "task-workspace": [1, 2] }), // non-string tool names
			JSON.stringify({ "task-workspace": null }), // null value
			"null",
			"42",
		]) {
			withContractEnv(raw, () => {
				const h = makeProbe(() => ["task_status", "report_result"].map((name) => ({ name })));
				expect(h.sessionStartHandler).toBeUndefined();
				expect(h.notifies).toHaveLength(0);
			});
		}
	});
});

describe("parseReadinessContract", () => {
	test("accepts a plain object with string keys and arrays of strings", () => {
		expect(parseReadinessContract(JSON.stringify({ e: ["a", "b"] }))).toEqual({ e: ["a", "b"] });
		expect(parseReadinessContract("{}")).toEqual({}); // valid empty contract
	});
	test("rejects missing, unparseable, and wrong-shape input", () => {
		expect(parseReadinessContract(undefined)).toBeUndefined();
		expect(parseReadinessContract("")).toBeUndefined();
		expect(parseReadinessContract("not json")).toBeUndefined();
		expect(parseReadinessContract("null")).toBeUndefined();
		expect(parseReadinessContract("42")).toBeUndefined();
		expect(parseReadinessContract('"str"')).toBeUndefined();
		expect(parseReadinessContract("[]")).toBeUndefined();
		expect(parseReadinessContract(JSON.stringify({ e: "a" }))).toBeUndefined();
		expect(parseReadinessContract(JSON.stringify({ e: ["a", 2] }))).toBeUndefined();
		expect(parseReadinessContract(JSON.stringify({ e: null }))).toBeUndefined();
	});
});
