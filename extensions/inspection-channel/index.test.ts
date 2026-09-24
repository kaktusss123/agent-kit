import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleInspectionRequest, validateInheritedFd, validateRequest } from "./index";

const deps = { cwd: process.cwd(), inspect: () => [{ id: "sa-1", state: "running" }] };

describe("inherited inspection protocol", () => {
	test("returns versioned bounded snapshots for each area", async () => {
		expect(await handleInspectionRequest('{"v":1,"id":"a","op":"snapshot","area":"subagents"}', deps)).toEqual({
			v: 1, id: "a", ok: true, result: { v: 1, area: "subagents", data: { agents: [{ id: "sa-1", state: "running" }] } },
		});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-task-"));
		const previous = process.env.AGENT_TASK_ROOT;
		process.env.AGENT_TASK_ROOT = root;
		try {
			const task = await handleInspectionRequest('{"v":1,"id":"b","op":"snapshot","area":"task"}', deps);
			expect(task).toMatchObject({ v: 1, id: "b", ok: true, result: { v: 1, area: "task" } });
		} finally {
			if (previous === undefined) delete process.env.AGENT_TASK_ROOT;
			else process.env.AGENT_TASK_ROOT = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects malformed, unknown and invalid requests without throwing", async () => {
		expect(await handleInspectionRequest("not-json", deps)).toMatchObject({ ok: false, error: { code: "malformed_json" } });
		expect(await handleInspectionRequest('{"v":2,"id":"x","op":"snapshot","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_version" } });
		expect(await handleInspectionRequest('{"v":1,"id":"x","op":"nope","area":"all"}', deps)).toMatchObject({ ok: false, error: { code: "unknown_op" } });
		expect(validateRequest({ v: 1, id: "x", op: "snapshot", area: "nope" })).toMatchObject({ error: { code: "unknown_area" } });
	});

	test("descriptor validation is numeric and fail-closed", () => {
		expect(validateInheritedFd(undefined)).toBeUndefined();
		expect(validateInheritedFd("1.5")).toBeUndefined();
		expect(validateInheritedFd("999999")).toBeUndefined();
	});
});
