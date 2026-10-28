import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultResultsDir, loadResult, migrateLegacyResults, saveResult, sessionKey, sumSessionCost } from "./result-store";
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

	test("loadResult prefers the legacy flat copy while one exists (transition protocol)", () => {
		const dir = makeDir();
		try {
			saveResult(result({ id: "new", task: "per-session" }), dir);
			writeLegacy(dir, result({ id: "old", task: "legacy" }));
			writeLegacy(dir, result({ id: "both", task: "legacy" }));
			saveResult(result({ id: "both", task: "per-session" }), dir);
			expect(loadResult("new", dir)?.task).toBe("per-session");
			expect(loadResult("old", dir)?.task).toBe("legacy");
			// A flat file for an id that ALSO has a per-session copy is a legacy
			// writer's re-write that landed AFTER the copy was migrated: the
			// legacy writer only ever moves a record forward (spawn marker ->
			// terminal), so while the flat file exists it is the newer state.
			expect(loadResult("both", dir)?.task).toBe("legacy");
			expect(loadResult("missing", dir)).toBeNull();
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

describe("migrateLegacyResults", () => {
	test("moves legacy files with parentSession, leaves the rest, is idempotent", () => {
		const dir = makeDir();
		try {
			writeLegacy(dir, result({ id: "a" }));
			writeLegacy(dir, result({ id: "b", parentSession: "/sessions/other.jsonl" }));
			const { parentSession: _p, ...noParent } = result({ id: "c" });
			writeLegacy(dir, noParent as AgentResult);
			fs.writeFileSync(path.join(dir, "broken.json"), "{not json", "utf8");
			fs.writeFileSync(path.join(dir, "keep.json.tmp"), "{}", "utf8");

			expect(migrateLegacyResults(dir)).toBe(2);
			const key = (s: string) => path.join(dir, "by-session", sessionKey(s));
			expect(fs.existsSync(path.join(key("/sessions/main.jsonl"), "a.json"))).toBe(true);
			expect(fs.existsSync(path.join(key("/sessions/other.jsonl"), "b.json"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "a.json"))).toBe(false);
			expect(fs.existsSync(path.join(dir, "c.json"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "broken.json"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "keep.json.tmp"))).toBe(true);
			expect(loadResult("a", dir)?.id).toBe("a");

			expect(migrateLegacyResults(dir)).toBe(0);
			expect(migrateLegacyResults(path.join(dir, "absent"))).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a stale migrated snapshot is upgraded from the legacy re-write", () => {
		const dir = makeDir();
		try {
			// A migrated snapshot still says "running" while the legacy writer
			// has already re-published a terminal state to the flat path: the
			// pass must adopt the terminal record, not pin the stale marker
			// behind an EEXIST skip.
			saveResult(result({ id: "a", status: "running" }), dir);
			writeLegacy(dir, result({ id: "a" }));
			expect(migrateLegacyResults(dir)).toBe(1);
			expect(fs.existsSync(path.join(dir, "a.json"))).toBe(false);
			expect(loadResult("a", dir)?.status).toBe("completed");
			const key = path.join(dir, "by-session", sessionKey("/sessions/main.jsonl"));
			expect(JSON.parse(fs.readFileSync(path.join(key, "a.json"), "utf8")).status).toBe("completed");
			expect(migrateLegacyResults(dir)).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("F1: a live legacy writer's terminal re-write is served, not shadowed", () => {
		const dir = makeDir();
		try {
			writeLegacy(dir, result({ id: "a", status: "running" })); // old process spawn marker
			expect(migrateLegacyResults(dir)).toBe(1); // the upgrade migrates the marker
			// the still-running old process publishes its terminal state to the
			// flat path, exactly as the pre-upgrade code does
			writeLegacy(dir, result({ id: "a" }));
			expect(loadResult("a", dir)?.status).toBe("completed");
			// the next pass adopts the terminal record instead of skipping it
			expect(migrateLegacyResults(dir)).toBe(1);
			expect(fs.existsSync(path.join(dir, "a.json"))).toBe(false);
			expect(loadResult("a", dir)?.status).toBe("completed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("two concurrent migrations leave every result exactly once and do not throw", async () => {
		const dir = makeDir();
		try {
			const ids = Array.from({ length: 200 }, (_, i) => `r${i}`);
			for (const id of ids) writeLegacy(dir, result({ id, parentSession: `/sessions/s${Number(id.slice(1)) % 5}.jsonl` }));
			// Two real processes race over the same directory.
			const script = `import { migrateLegacyResults } from ${JSON.stringify(path.join(import.meta.dir, "result-store.ts"))};
migrateLegacyResults(${JSON.stringify(dir)});`;
			const run = () =>
				new Promise<number | null>((resolve) => {
					const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
					child.on("exit", (code) => resolve(code));
				});
			expect(await Promise.all([run(), run()])).toEqual([0, 0]);
			expect(fs.readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
			let count = 0;
			for (const k of fs.readdirSync(path.join(dir, "by-session"))) {
				count += fs.readdirSync(path.join(dir, "by-session", k)).length;
			}
			expect(count).toBe(ids.length);
			for (const id of ids) expect(loadResult(id, dir)?.id).toBe(id);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
