import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultResultsDir, saveResult, sumSessionCost } from "./result-store";
import type { AgentResult } from "./types";

function makeDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "result-store-test-"));
}

function result(overrides: Partial<AgentResult> & Pick<AgentResult, "id">): AgentResult {
	return {
		label: "lab",
		task: "t",
		cwd: "/tmp",
		status: "completed",
		startedAt: 0,
		parentSession: "/sessions/main.jsonl",
		tokens: { input: 1, output: 1, total: 2, cost: 0.25 },
		...overrides,
	};
}

describe("sumSessionCost", () => {
	test("returns 0 for a missing directory", () => {
		expect(sumSessionCost(path.join(makeDir(), "absent"), "/sessions/main.jsonl")).toBe(0);
	});

	test("sums only results attributed to the parent session", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "a", tokens: { input: 1, output: 1, total: 2, cost: 0.1 } }), dir);
			saveResult(
				result({ id: "b", parentSession: "/sessions/other.jsonl", tokens: { input: 1, output: 1, total: 2, cost: 5 } }),
				dir,
			);
			saveResult(result({ id: "c", tokens: { input: 1, output: 1, total: 2, cost: 0.05 } }), dir);
			expect(sumSessionCost(dir, "/sessions/main.jsonl")).toBeCloseTo(0.15, 10);
			expect(sumSessionCost(dir, "/sessions/other.jsonl")).toBe(5);
			expect(sumSessionCost(dir, "/sessions/none.jsonl")).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("treats missing cost and unreadable entries as zero", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "a", tokens: { input: 1, output: 1, total: 2 } }), dir);
			fs.writeFileSync(path.join(dir, "broken.json"), "{not json", "utf8");
			fs.writeFileSync(path.join(dir, "partial.json.tmp"), "{}", "utf8");
			expect(sumSessionCost(dir, "/sessions/main.jsonl")).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("defaultResultsDir", () => {
	test("honors PI_CODING_AGENT_DIR", () => {
		const prev = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir-test";
			expect(defaultResultsDir()).toBe(path.join("/tmp/agent-dir-test", "subagents", "results"));
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});
});
