/**
 * Migration races against a live legacy writer and against a concurrent
 * move landing between a reader's directory listings. These windows cannot
 * be produced by plain sequential calls — they need another process's
 * operation to land between two of the store's own syscalls — so the tests
 * inject an `io` wrapper that performs exactly that operation at the syscall
 * the race needs, and assert the wrapper was actually consulted (otherwise
 * the pass would be trivially green). Everything else passes through to the
 * real fs.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listAllResults, loadResult, migrateLegacyResults, saveResult, sessionKey, sumSessionCost } from "./result-store";
import type { ResultStoreIo } from "./result-store";
import type { AgentResult } from "./types";

function makeDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "result-store-race-"));
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

/** Publish exactly like the store and the legacy writer do: tmp + rename. */
function publish(dir: string, r: AgentResult): void {
	const file = path.join(dir, `${r.id}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(r), "utf8");
	fs.renameSync(tmp, file);
}

describe("migration vs a live legacy writer", () => {
	test("a legacy re-write landing between the snapshot and the removal is never deleted", () => {
		const dir = makeDir();
		try {
			const flat = path.join(dir, "a.json");
			publish(dir, result({ id: "a", status: "running" })); // legacy spawn marker
			let hooked = false;
			// The legacy writer publishes its terminal state exactly when the
			// migration is about to rename the snapshotted source away.
			const io: ResultStoreIo = {
				...fs,
				renameSync: (from: fs.PathLike, to: fs.PathLike) => {
					if (from === flat && to === `${flat}.migrating` && !hooked) {
						hooked = true;
					publish(dir, result({ id: "a" })); // the writer's rename wins the race
					}
					return fs.renameSync(from, to);
				},
			};
			migrateLegacyResults(dir, io);
			expect(hooked).toBe(true); // the interleave was really exercised
			// The terminal state must survive the race and be readable right
			// away: the recovery sweep adopts the newer publish parked at the
			// trash name.
			expect(loadResult("a", dir)?.status).toBe("completed");
			migrateLegacyResults(dir);
			expect(loadResult("a", dir)?.status).toBe("completed");
			// nothing lingers: no flat copy, no trash shadows
			expect(fs.readdirSync(dir).filter((n: string) => n.startsWith("a.json"))).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reads vs a concurrent migration", () => {
	test("a file moved between a rollup's directory walks is still counted", () => {
		const dir = makeDir();
		try {
			publish(dir, result({ id: "a" })); // flat only
			let hooked = false;
			const io: ResultStoreIo = {
				...fs,
				readdirSync: ((p: string, options?: unknown) => {
					const listing = fs.readdirSync(p, options as never) as string[];
					// The migration lands right after the flat directory listing
					// was taken: the returned listing is already stale.
					if (p === dir && !hooked && listing.includes("a.json")) {
						hooked = true;
						const target = path.join(dir, "by-session", sessionKey("/sessions/main.jsonl"));
						fs.mkdirSync(target, { recursive: true });
						fs.renameSync(path.join(dir, "a.json"), path.join(target, "a.json"));
						return listing;
					}
					return listing;
				}) as ResultStoreIo["readdirSync"],
			};
			try {
				expect(sumSessionCost(dir, "/sessions/main.jsonl", io)).toBe(0.25);
				expect(hooked).toBe(true);
				expect(listAllResults(dir, io)).toHaveLength(1);
			} finally {
				// plain fs from here on
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadResult survives the file moving between its listings", () => {
		const dir = makeDir();
		try {
			// The result already sits in its per-session directory, but the
			// first by-session listing — taken while the move is still in
			// flight — does not know the new session directory yet.
			saveResult(result({ id: "a" }), dir);
			let hooked = false;
			const io: ResultStoreIo = {
				...fs,
				readdirSync: ((p: string, options?: unknown) => {
					if (p === path.join(dir, "by-session") && !hooked) {
						hooked = true;
						return [];
					}
					return fs.readdirSync(p, options as never);
				}) as ResultStoreIo["readdirSync"],
			};
			try {
				expect(loadResult("a", dir, io)?.id).toBe("a");
				expect(hooked).toBe(true);
			} finally {
				// plain fs from here on
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
