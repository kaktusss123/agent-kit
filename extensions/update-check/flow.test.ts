import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { readUpdateState } from "./check";
import { findCheckout, runOffMainCheck, runUpdateCheck } from "./index";

let dir: string;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function sh(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function commitAll(repo: string, message: string): void {
	execFileSync("git", ["-C", repo, "add", "-A"]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message]);
}

/** bare origin + seed clone + tracking clone, one initial commit on main. */
function setup(): { origin: string; seed: string; repo: string; file: string; toasts: string[] } {
	dir = mkdtempSync(join(tmpdir(), "update-check-"));
	const origin = join(dir, "origin.git");
	const seed = join(dir, "seed");
	const repo = join(dir, "repo");
	execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	writeFileSync(join(seed, "README.md"), "x\n");
	commitAll(seed, "init");
	execFileSync("git", ["-C", seed, "push", "-q", origin, "main"]);
	execFileSync("git", ["clone", "-q", origin, repo]);
	return { origin, seed, repo, file: join(dir, "state", "update-check.json"), toasts: [] };
}

function run(
	repo: string,
	file: string,
	toasts: string[],
	now: () => number,
): Promise<{ ran: boolean; outdated: boolean; notified: boolean }> {
	return runUpdateCheck(repo, {
		file,
		now,
		notify: (message) => toasts.push(message),
	});
}

test("findCheckout walks three dirnames up from the extension file", () => {
	const base = mkdtempSync(join(tmpdir(), "update-check-find-"));
	try {
		const deep = join(base, "extensions", "update-check");
		execFileSync("mkdir", ["-p", deep]);
		const file = join(deep, "index.ts");
		writeFileSync(file, "export {};\n");
		expect(findCheckout(file)).toBe(realpathSync(base));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("full lifecycle: check, skip, outdated toast, cached toast, refresh after pull", async () => {
	const { origin, seed, repo, file, toasts } = setup();
	let t = 1_000_000;
	const now = () => t;

	// First start: network check, up to date, cache written, no toast.
	expect(await run(repo, file, toasts, now)).toEqual({ ran: true, outdated: false, notified: false });
	expect(toasts).toEqual([]);
	expect(readUpdateState(file)?.status).toBe("up-to-date");

	// Cache fresh: next start stays silent, no network.
	t += 1;
	expect(await run(repo, file, toasts, now)).toEqual({ ran: false, outdated: false, notified: false });

	// Upstream moves past the interval: network check toasts once.
	t += 6 * 60 * 60 * 1000;
	writeFileSync(join(seed, "feat.md"), "new\n");
	commitAll(seed, "feat");
	execFileSync("git", ["-C", seed, "push", "-q", origin, "main"]);
	expect(await run(repo, file, toasts, now)).toEqual({ ran: true, outdated: true, notified: true });
	expect(toasts).toHaveLength(1);
	expect(toasts[0]).toContain("agent-kit update");
	expect(toasts[0]).toContain("behind origin/main");
	const cached = readUpdateState(file);
	expect(cached?.status).toBe("outdated");

	// Next start: toast again from cache, no network.
	t += 1;
	expect(await run(repo, file, toasts, now)).toEqual({ ran: false, outdated: true, notified: true });
	expect(toasts).toHaveLength(2);

	// agent-kit update (pull) moved HEAD: fresh check settles the cache, no stale toast.
	sh(repo, "pull", "--ff-only");
	expect(await run(repo, file, toasts, now)).toEqual({ ran: true, outdated: false, notified: false });
	expect(toasts).toHaveLength(2);
	expect(readUpdateState(file)?.status).toBe("up-to-date");
});

test("off-main check reminds on a non-default branch only", async () => {
	const { repo, toasts } = setup();

	// On the default branch: silent.
	expect(await runOffMainCheck(repo, (m) => toasts.push(m))).toBe(false);
	expect(toasts).toEqual([]);

	// A feature branch is exactly the forgotten-worktree case: remind, and
	// the message carries the copy-pasteable switch-back command.
	execFileSync("git", ["-C", repo, "switch", "-q", "-c", "feat/forgot"]);
	expect(await runOffMainCheck(repo, (m) => toasts.push(m))).toBe(true);
	expect(toasts).toHaveLength(1);
	expect(toasts[0]).toContain("'feat/forgot'");
	expect(toasts[0]).toContain("switch main && agent-kit update");

	// Detached HEAD: out of scope, silent.
	execFileSync("git", ["-C", repo, "checkout", "-q", "--detach"]);
	expect(await runOffMainCheck(repo, (m) => toasts.push(m))).toBe(false);
	expect(toasts).toHaveLength(1);
});

test("repository without an upstream stays silent and caches nothing", async () => {
	const bare = mkdtempSync(join(tmpdir(), "update-check-noup-"));
	dir = bare; // cleaned by afterEach
	const repo = join(bare, "lonely");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	writeFileSync(join(repo, "README.md"), "x\n");
	execFileSync("git", ["-C", repo, "add", "-A"]);
	execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
	const file = join(bare, "state", "update-check.json");
	const toasts: string[] = [];

	expect(await run(repo, file, toasts, () => 1_000)).toEqual({
		ran: true,
		outdated: false,
		notified: false,
	});
	expect(toasts).toEqual([]);
	expect(existsSync(file)).toBe(false);
});
