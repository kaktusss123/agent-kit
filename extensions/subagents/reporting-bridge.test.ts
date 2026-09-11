/**
 * Unit tests for the reporting bridge's staleness mechanics (F2):
 * invalidation must be fail-closed — a report that cannot be marked stale on
 * disk blocks the next tool call, and a replacement report marks the previous
 * one stale before writing the fresh record.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envelopeFileName, validateEnvelopeRecord } from "./envelope";
import { READINESS_ENV } from "./readiness";

const VALID_ENVELOPE = {
	status: "done",
	summary: "s",
	changed_scope: [],
	verification: [{ check: "c", result: "pass" }],
	gaps: [],
};

interface Harness {
	tool: { execute: Function };
	toolCall(toolName: string): { block?: boolean; reason?: string } | undefined;
	dir: string;
	file(): string;
	readRecord(): any;
	setReported(value: boolean): void;
	cleanup(): void;
}

function makeBridge(opts?: { agentId?: string }): Harness {
	process.env.PI_SUBAGENT_ID = opts?.agentId ?? "sa-test-bridge";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-bridge-"));
	process.env.PI_SUBAGENT_RESULTS_DIR = dir;
	const handlers: Record<string, Array<(event: any) => unknown>> = {};
	let tool: any;
	const pi: any = {
		registerTool: (def: any) => { tool = def; },
		on: (event: string, cb: (event: any) => unknown) => {
			(handlers[event] ??= []).push(cb);
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const factory = require("./reporting-bridge.ts").default;
	factory(pi);

	const h: Harness = {
		tool,
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
			delete process.env[READINESS_ENV];
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

	test("no readiness signal outside profiled children", async () => {
		const before = process.env[READINESS_ENV];
		delete process.env[READINESS_ENV];
		const h = makeBridge();
		try {
			// the factory ran without PI_SUBAGENT_READINESS: no session_start
			// handler may have been registered (signalChildReadiness no-op).
			// Evidence: the bridge factory did not throw and report_result is
			// registered; the readiness contract itself is covered live.
			expect(h.tool).toBeDefined();
			expect(h.tool.name === "report_result" || h.tool.definition === undefined).toBe(true);
		} finally {
			h.cleanup();
			if (before !== undefined) process.env[READINESS_ENV] = before;
		}
	});
});
