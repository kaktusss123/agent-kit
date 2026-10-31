import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProgress, progressFileName, saveProgress, validateProgress } from "./progress.ts";

const input = { achieved: "done", currentWork: "test", nextStep: "commit" };

describe("progress handoff compatibility", () => {
	test("closed validated payload, bounded reads, malformed or absent data cannot fabricate progress", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-contract-"));
		try {
			expect(loadProgress("sa-1", dir)).toBeUndefined();
			const progress = saveProgress("sa-1", input, dir);
			expect(loadProgress("sa-1", dir)).toEqual(progress);
			expect(fs.existsSync(path.join(dir, progressFileName("sa-1") + ".tmp"))).toBe(false);
			for (const malformed of [null, [], { ...progress, updatedAt: "1" }, { ...progress, output: "private" }, { ...progress, updatedAt: Infinity }, { ...progress, achieved: "x".repeat(1001) }]) {
				expect(validateProgress(malformed)).toBeUndefined();
			}
			const file = path.join(dir, progressFileName("sa-1"));
			for (const bad of ["bad json", JSON.stringify({ agentId: "other", progress }), JSON.stringify({ agentId: "sa-1", progress, transcript: "private" }), " ".repeat(32001)]) {
				fs.writeFileSync(file, bad);
				expect(loadProgress("sa-1", dir)).toBeUndefined();
			}
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
