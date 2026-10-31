import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultResultsDir, listAllResults, loadResult, saveResult, sessionKey, sumSessionCost } from "./result-store.ts";
import type { AgentResult } from "./types.ts";

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

function writeLegacy(dir: string, r: AgentResult): string {
	const file = path.join(dir, `${r.id}.json`);
	fs.writeFileSync(file, JSON.stringify(r), "utf8");
	return file;
}

describe("per-session layout", () => {
	test("sessionKey is the first 32 hex chars of SHA-256 (cross-repo vector)", () => {
		expect(sessionKey("/sessions/main.jsonl")).toBe("addc20b5f17570458c7148ef1f258114");
		expect(sessionKey("")).toBe("e3b0c44298fc1c149afbf4c8996fb924");
	});

	test("saveResult writes per-session when parentSession is set, flat otherwise", () => {
		const dir = makeDir();
		try {
			const a = saveResult(result({ id: "a" }), dir);
			expect(a).toBe(path.join(dir, "by-session", sessionKey("/sessions/main.jsonl"), "a.json"));
			expect(fs.existsSync(a)).toBe(true);
			const { parentSession: _p, ...noParent } = result({ id: "b" });
			expect(saveResult(noParent as AgentResult, dir)).toBe(path.join(dir, "b.json"));
			expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadResult finds per-session and flat-only legacy results", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "new", task: "per-session" }), dir);
			writeLegacy(dir, result({ id: "old", task: "legacy" }));
			expect(loadResult("new", dir)?.task).toBe("per-session");
			expect(loadResult("old", dir)?.task).toBe("legacy");
			expect(loadResult("missing", dir)).toBeNull();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("flat running + by-session terminal (same id): terminal wins in loadResult, listing and cost", () => {
		const dir = makeDir();
		try {
			writeLegacy(dir, result({ id: "a", status: "running", startedAt: 5, tokens: undefined }));
			saveResult(result({ id: "a", status: "completed", startedAt: 5, endedAt: 9 }), dir);
			expect(loadResult("a", dir)?.status).toBe("completed");
			const listed = listAllResults(dir);
			expect(listed).toHaveLength(1);
			expect(listed[0]?.status).toBe("completed");
			expect(sumSessionCost(dir, "/sessions/main.jsonl")).toBe(0.25);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("by-session running + flat terminal (same id): terminal wins, cost counted once", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "a", status: "running", startedAt: 5, tokens: undefined }), dir);
			writeLegacy(dir, result({ id: "a", status: "failed", startedAt: 5, endedAt: 9 }));
			expect(loadResult("a", dir)?.status).toBe("failed");
			const listed = listAllResults(dir);
			expect(listed).toHaveLength(1);
			expect(listed[0]?.status).toBe("failed");
			expect(sumSessionCost(dir, "/sessions/main.jsonl")).toBe(0.25);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("between two terminal copies the later endedAt wins", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "a", task: "early", endedAt: 10 }), dir);
			writeLegacy(dir, result({ id: "a", task: "late", endedAt: 20 }));
			expect(loadResult("a", dir)?.task).toBe("late");
			saveResult(result({ id: "b", task: "late", endedAt: 30 }), dir);
			writeLegacy(dir, result({ id: "b", task: "early", endedAt: 15 }));
			expect(loadResult("b", dir)?.task).toBe("late");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sumSessionCost spans per-session and legacy files without double counting", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "a", tokens: { input: 1, output: 1, total: 2, cost: 1 } }), dir);
			writeLegacy(dir, result({ id: "b", tokens: { input: 1, output: 1, total: 2, cost: 2 } }));
			writeLegacy(dir, result({ id: "a", tokens: { input: 1, output: 1, total: 2, cost: 1 } }));
			expect(sumSessionCost(dir, "/sessions/main.jsonl")).toBe(3);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("extension start", () => {
	test("importing the extension entry does not touch the results directory", async () => {
		const dir = makeDir();
		const prev = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			const resultsDir = defaultResultsDir();
			writeLegacy((fs.mkdirSync(resultsDir, { recursive: true }), resultsDir), result({ id: "a" }));
			const snapshot = (): string[] => fs.readdirSync(resultsDir, { recursive: true }).map(String).sort();
			const before = snapshot();
			const mod = await import("./index.ts");
			const handlers: unknown[] = [];
			const pi = new Proxy({}, { get: () => (...args: unknown[]) => handlers.push(args) });
			try {
				(mod.default as (pi: unknown) => void)(pi);
			} catch {
				// registration may need a fuller host; only filesystem effects matter here
			}
			expect(snapshot()).toEqual(before);
			expect(fs.existsSync(path.join(resultsDir, "a.json"))).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
