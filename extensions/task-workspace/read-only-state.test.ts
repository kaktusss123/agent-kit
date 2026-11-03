/**
 * Contract tests for the published task-workspace read-only source
 * (`docs/read-only-state.md`, version 1): publish/bind/generation, the
 * unavailable-vs-none-vs-error distinction, stale-generation capture, reload
 * ownership, and the cross-source owner enrichment read through the subagents
 * slot.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, beforeEach, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { ensureTaskRepo } from "./flows.ts";

const KEY = Symbol.for("agentkit.read-only-state.v1");
const modulePath = join(import.meta.dirname, "read-only-state.ts");
const source = await import(modulePath);

type TaskRecord = {
	version: number;
	owner: unknown;
	sessionGeneration: () => number;
	read: () => Promise<
		| { status: "ok"; generation: number; projection: { state: string; repos: { owners: unknown[] }[] } }
		| { status: "unavailable"; reason: string }
		| { status: "error"; error: { code: string; message: string } }
	>;
};
type Registry = { schemaVersion: number; subagents?: unknown; taskWorkspace?: TaskRecord };

let rootDir: string | undefined;
const tempDir = (prefix: string): string => {
	rootDir ??= mkdtempSync(join(tmpdir(), "read-only-state-"));
	const dir = join(rootDir, `${prefix}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const sh = (cwd: string, ...cmd: string[]): string =>
	execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" }).trim();

/** Local source repo with one commit on main and a free task branch. */
function makeSourceRepo(name: string): { source: string; taskRoot: string } {
	const base = tempDir(name);
	const repo = join(base, "src");
	const taskRoot = join(base, "tasks");
	mkdirSync(repo, { recursive: true });
	mkdirSync(taskRoot, { recursive: true });
	sh(repo, "git", "init", "-q", "-b", "main");
	sh(repo, "git", "config", "user.email", "test@example.invalid");
	sh(repo, "git", "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "init\n");
	sh(repo, "git", "add", "-A");
	sh(repo, "git", "commit", "-qm", "init");
	sh(repo, "git", "branch", "feat/work");
	return { source: repo, taskRoot };
}

function registry(): Registry | undefined {
	return (globalThis as Record<symbol, unknown>)[KEY] as Registry | undefined;
}

function slot(): TaskRecord {
	const record = registry()?.taskWorkspace;
	expect(record).toBeDefined();
	return record!;
}

beforeEach(() => {
	delete (globalThis as Record<symbol, unknown>)[KEY];
});

afterAll(() => {
	delete (globalThis as Record<symbol, unknown>)[KEY];
	if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe("task-workspace read-only source: session binding", () => {
	test("published source without a bound session is unavailable, not an empty projection", async () => {
		source.publishTaskWorkspaceStateSource({ taskRoot: "/tmp/no-session" });
		expect(slot().version).toBe(1);
		expect(slot().sessionGeneration()).toBe(0);
		expect(await slot().read()).toEqual({ status: "unavailable", reason: "no_session" });
	});

	test("bind computes Core's projection and carries the session generation", async () => {
		const base = tempDir("plain");
		source.publishTaskWorkspaceStateSource({ taskRoot: base });
		const generation = source.bindTaskWorkspaceSession({ cwd: base, branchEntries: () => [] });
		expect(generation).toBe(1);
		expect(slot().sessionGeneration()).toBe(1);
		const result = await slot().read();
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.generation).toBe(1);
		// No managed association: an explicit `none`, never an invented workspace.
		expect(result.projection).toEqual({ state: "none", identity: null, workspace: null, source: null, repos: [] });
	});

	test("a session switch increments the generation and a stale read keeps its own", async () => {
		let settle: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (settle = resolve));
		source.publishTaskWorkspaceStateSource({
			taskRoot: "/tmp/generation",
			project: async (input: { generation: number }) => {
				await gate;
				return { state: "none", identity: null, workspace: null, source: null, repos: [], generationSeen: input.generation } as never;
			},
		});
		source.bindTaskWorkspaceSession({ cwd: "/tmp/one", branchEntries: () => [] });
		const before = source.taskWorkspaceSessionGeneration();
		const pending = slot().read();
		// Session switch while the projection is in flight.
		source.bindTaskWorkspaceSession({ cwd: "/tmp/two", branchEntries: () => [] });
		settle?.();
		const result = await pending;
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		// The result belongs to the binding captured at read start, so a consumer
		// comparing it with sessionGeneration() can discard it as stale.
		expect(result.generation).toBe(before);
		expect(slot().sessionGeneration()).toBe(before + 1);
	});

	test("clearing the session makes the source unavailable again", async () => {
		const base = tempDir("cleared");
		source.publishTaskWorkspaceStateSource({ taskRoot: base });
		source.bindTaskWorkspaceSession({ cwd: base, branchEntries: () => [] });
		source.clearTaskWorkspaceSession();
		expect(await slot().read()).toEqual({ status: "unavailable", reason: "no_session" });
	});
});

describe("task-workspace read-only source: errors are distinct", () => {
	test("a failing projection is an explicit error result", async () => {
		source.publishTaskWorkspaceStateSource({
			taskRoot: "/tmp/error",
			project: async () => {
				throw new Error("git unavailable");
			},
		});
		source.bindTaskWorkspaceSession({ cwd: "/tmp/error", branchEntries: () => [] });
		expect(await slot().read()).toEqual({
			status: "error",
			error: { code: "projection_failed", message: "git unavailable" },
		});
	});
});

describe("task-workspace read-only source: reload ownership", () => {
	test("a reloaded graph wins and a stale shutdown keeps it", async () => {
		const first = (await import(`${modulePath}?copy=first`)) as typeof source;
		const second = (await import(`${modulePath}?copy=second`)) as typeof source;
		first.publishTaskWorkspaceStateSource({ taskRoot: "/tmp/first" });
		const oldOwner = slot().owner;
		second.publishTaskWorkspaceStateSource({ taskRoot: "/tmp/second" });
		expect(slot().owner).not.toBe(oldOwner);
		first.withdrawTaskWorkspaceStateSource();
		expect(registry()?.taskWorkspace).toBeDefined();
		second.withdrawTaskWorkspaceStateSource();
		expect(registry()?.taskWorkspace).toBeUndefined();
	});
});

describe("task-workspace read-only source: owner enrichment", () => {
	test("active workspace owners come from the subagents slot; absence yields none", async () => {
		const { source: repo, taskRoot } = makeSourceRepo("owners");
		const ensured = (await ensureTaskRepo(
			{ branch: "feat/work", source_path: repo } as never,
			repo,
			{ taskRoot },
		)) as { status: string; worktree: string };
		expect(ensured.status).toBe("attached");
		// The session cwd is the managed worktree inside the workspace directory.
		source.publishTaskWorkspaceStateSource({ taskRoot });
		source.bindTaskWorkspaceSession({ cwd: ensured.worktree, branchEntries: () => [] });

		// No subagents source: the projection still works, with no owner refs.
		const withoutOwners = await slot().read();
		expect(withoutOwners.status).toBe("ok");
		if (withoutOwners.status !== "ok") return;
		expect(withoutOwners.projection.state).toBe("ok");
		expect(withoutOwners.projection.repos[0].owners).toEqual([]);

		// A live subagents source with an active owner on this exact workspace.
		const subagents = await import("../subagents/read-only-state.ts");
		subagents.publishSubagentStateSource(() => [
			{ id: "owner-1", label: "owner", state: "running", alive: true, run: { workspace: ensured.worktree, state: "running" } },
			{ id: "settled", label: "old", state: "completed", alive: false, run: { workspace: ensured.worktree, state: "done", result: { status: "done" } } },
		]);
		const withOwners = await slot().read();
		expect(withOwners.status).toBe("ok");
		if (withOwners.status !== "ok") return;
		expect(withOwners.projection.repos[0].owners).toEqual([{ id: "owner-1", label: "owner", state: "running" }]);
	});
});
