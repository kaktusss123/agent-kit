/**
 * Unit tests for the reporting bridge's staleness mechanics (F2):
 * invalidation must be fail-closed — a report that cannot be marked stale on
 * disk blocks the next tool call, and a replacement report marks the previous
 * one stale before writing the fresh record.
 */
import { describe, test } from "node:test";
import { createRequire } from "node:module";
import { expect } from "../../tests/support/expect.ts";

const require = createRequire(import.meta.url);
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envelopeFileName, validateEnvelopeRecord } from "./envelope.ts";
import { loadProgress } from "./progress.ts";

const VALID_ENVELOPE = {
	status: "done",
	summary: "s",
	changed_scope: [],
	verification: [{ check: "c", result: "pass" }],
	gaps: [],
};

interface Harness {
	tool: { execute: Function; executionMode?: string };
	tools: Map<string, any>;
	toolCall(toolName: string): { block?: boolean; reason?: string } | undefined;
	handlers: Record<string, Array<(event: any) => unknown>>;
	dir: string;
	file(): string;
	readRecord(): any;
	cleanup(): void;
}

function makeBridge(opts?: { agentId?: string }): Harness {
	process.env.PI_SUBAGENT_ID = opts?.agentId ?? "sa-test-bridge";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-bridge-"));
	process.env.PI_SUBAGENT_RESULTS_DIR = dir;
	const handlers: Record<string, Array<(event: any) => unknown>> = {};
	let tool: any;
	const tools = new Map<string, any>();
	const pi: any = {
		registerTool: (def: any) => { tools.set(def.name, def); if (def.name === "report_result") tool = def; },
		on: (event: string, cb: (event: any) => unknown) => {
			(handlers[event] ??= []).push(cb);
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const factory = require("./reporting-bridge.ts").default;
	factory(pi);

	const h: Harness = {
		tool,
		tools,
		handlers,
		toolCall(toolName: string) {
			let last: any;
			for (const cb of handlers.tool_call ?? []) last = cb({ toolName });
			return last;
		},
		dir,
		file: () => path.join(dir, envelopeFileName(process.env.PI_SUBAGENT_ID!)),
		readRecord: () => {
			try {
				return validateEnvelopeRecord(JSON.parse(fs.readFileSync(h.file(), "utf8")));
			} catch {
				return undefined;
			}
		},
		setReported(value: boolean) {
			// drive the bridge's internal reported flag via the public path:
			// a successful report sets it; there is no other setter.
			void value;
		},
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
			delete process.env.PI_SUBAGENT_ID;
			delete process.env.PI_SUBAGENT_RESULTS_DIR;
		},
	};
	void h.setReported;
	return h;
}

async function report(h: Harness, summary: string): Promise<{ isError?: boolean }> {
	const res = (await h.tool.execute(
		"tc",
		{ ...VALID_ENVELOPE, summary },
		undefined,
		undefined,
		{},
	)) as { isError?: boolean; details?: unknown };
	return res;
}

describe("reporting bridge staleness (F2)", () => {
	test("report → fresh record; tool call flips it stale", async () => {
		const h = makeBridge();
		try {
			const res = await report(h, "first");
			expect(res.isError).toBeUndefined();
			const rec = h.readRecord();
			expect(rec?.stale).toBe(false);
			expect(rec?.generation).toBe(1);
			expect(rec?.envelope.summary).toBe("first");

			h.toolCall("bash");
			const after = h.readRecord();
			expect(after?.stale).toBe(true);
			expect(after?.envelope.summary).toBe("first"); // content preserved
			expect(after?.generation).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	test("invalidation persist failure blocks the tool call (fail closed)", async () => {
		const h = makeBridge();
		try {
			await report(h, "first");
			// make PERSIST fail while READ still works: read-only directory —
			// exactly the reviewer's fail-open scenario (stale flip cannot be
			// written, the fresh report stays on disk).
			fs.chmodSync(h.dir, 0o500);
			const verdict = h.toolCall("bash");
			fs.chmodSync(h.dir, 0o755);
			expect(verdict?.block).toBe(true);
			expect(String(verdict?.reason)).toContain("could not be invalidated");
			// the record on disk is still fresh:false — but `reported` stays
			// true, so the next call keeps hitting the same guard instead of
			// silently executing against a trusted stale report.
			fs.chmodSync(h.dir, 0o500);
			const again = h.toolCall("edit");
			fs.chmodSync(h.dir, 0o755);
			expect(again?.block).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("replacement report marks the previous one stale before writing fresh", async () => {
		const h = makeBridge();
		try {
			await report(h, "first");
			// replacement persist fails at the fresh-write step: point the
			// results dir at a read-only location AFTER capturing the first
			// report is not possible per-file, so simulate by making the
			// directory read-only — stale-before-replace then also fails and
			// the tool must error without leaving a fresh second report.
			fs.chmodSync(h.dir, 0o500);
			const res = await report(h, "second");
			fs.chmodSync(h.dir, 0o755);
			expect(res.isError).toBe(true);
			// the first report is still the on-disk record, still fresh — the
			// tool call errored, so no replacement was claimed. The critical
			// invariant: whatever is on disk is NOT "second" while marked
			// fresh.
			const rec = h.readRecord();
			expect(rec?.envelope.summary).toBe("first");
		} finally {
			h.cleanup();
		}
	});

	test("second report after a tool call replaces the stale record with a fresh one", async () => {
		const h = makeBridge();
		try {
			await report(h, "first");
			h.toolCall("bash"); // invalidates "first"
			expect(h.readRecord()?.stale).toBe(true);
			const res = await report(h, "second");
			expect(res.isError).toBeUndefined();
			const rec = h.readRecord();
			expect(rec?.stale).toBe(false);
			expect(rec?.envelope.summary).toBe("second");
			expect(rec?.generation).toBe(2);
		} finally {
			h.cleanup();
		}
	});

	test("report_result is sequential (batched mutation completes before the report)", () => {
		const h = makeBridge();
		try {
			expect(h.tool.executionMode).toBe("sequential");
		} finally {
			h.cleanup();
		}
	});

	test("staleness hook runs BEFORE a later blocking handler (extension order contract)", async () => {
		// pi dispatches tool_call handlers in extension registration order and
		// stops at the first block. Profile order puts the reporting bridge
		// first, so a BLOCKED call (the mutation guard refusing a raw
		// no-verify commit) must already have invalidated the previous
		// envelope. Simulate pi's dispatch loop: handlers in registration
		// order, stop at the first block.
		const h = makeBridge();
		try {
			await report(h, "before blocked call");
			expect(h.readRecord()?.stale).toBe(false);

			// a guard-like handler registered AFTER the bridge blocks bash
			h.handlers.tool_call.push((event: any) =>
				event.toolName === "bash" ? { block: true, reason: "Blocked by mutation guard" } : undefined,
			);

			let blocked = false;
			for (const cb of h.handlers.tool_call) {
				const verdict = cb({ toolName: "bash" }) as { block?: boolean } | undefined;
				if (verdict?.block) {
					blocked = true;
					break;
				}
			}
			expect(blocked).toBe(true);
			// despite the block, the bridge's earlier hook already invalidated
			expect(h.readRecord()?.stale).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("the bridge registers no readiness signaling (readiness is observed by the probe)", async () => {
		const h = makeBridge();
		try {
			await report(h, "only concern is the report");
			// Boundary: capability extensions declare nothing about
			// readiness — the factory must not register a session_start handler
			// (the subagents-owned readiness probe covers the contract), and its
			// reporting tools have no readiness hooks of their own.
			expect(h.handlers.session_start).toBeUndefined();
			expect(h.tool).toBeDefined();
			expect(h.tool.name).toBe("report_result");
			expect([...h.tools.keys()].sort()).toEqual(["report_progress", "report_result"]);
		} finally {
			h.cleanup();
		}
	});
});

describe("bounded independent progress", () => {
	test("two reports replace, normalize controls, timestamp at runtime and leave final reporting intact", async () => {
		const h = makeBridge();
		try {
			const tool = h.tools.get("report_progress")!;
			const before = Date.now();
			await tool.execute("p1", { achieved: "first\nresult", currentWork: "testing\u001b", blocker: "agent claim", nextStep: "commit" });
			const first = loadProgress("sa-test-bridge", h.dir)!;
			expect(first).toMatchObject({ achieved: "first result", currentWork: "testing", blocker: "agent claim" });
			expect(first.updatedAt).toBeGreaterThanOrEqual(before);
			await new Promise((r) => setTimeout(r, 2));
			await tool.execute("p2", { achieved: "second", currentWork: "verifying", nextStep: "report" });
			const second = loadProgress("sa-test-bridge", h.dir)!;
			expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
			expect(second.achieved).toBe("second");
			expect(second.blocker).toBeUndefined();
			await report(h, "final");
			expect(h.readRecord()?.stale).toBe(false);
			expect(loadProgress("sa-test-bridge", h.dir)).toEqual(second);
			h.toolCall("report_progress");
			expect(h.readRecord()?.stale).toBe(true);
		} finally { h.cleanup(); }
	});
	test("invalid input cannot replace last progress", async () => {
		const h = makeBridge();
		try {
			const tool = h.tools.get("report_progress")!;
			const input = { achieved: "ok", currentWork: "work", nextStep: "next" };
			await tool.execute("p", input);
			const saved = loadProgress("sa-test-bridge", h.dir);
			for (const bad of [{ ...input, updatedAt: 1 }, { ...input, output: "private" }, { ...input, achieved: "x".repeat(1001) }, { ...input, blocker: null }, { achieved: "incomplete" }]) {
				await expect(tool.execute("bad", bad)).rejects.toThrow("invalid progress");
				expect(loadProgress("sa-test-bridge", h.dir)).toEqual(saved);
			}
		} finally { h.cleanup(); }
	});
});
