/**
 * ensure_task_repo protected-branch tests: default development branches
 * (main, master, develop) are refused as task branches — canonical and lane
 * calls alike — before any worktree is created or branch state is changed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ensureTaskRepo } from "./flows";

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "ensure-protected-"));
  const dir = join(rootDir, prefix + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

function sh(cwd: string, ...cmd: string[]): string {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** Source repo, optionally with a bare origin, and its primary checkout off `main`. */
function makeSourceRepo(name: string, options?: { withRemote?: boolean }): { source: string; taskRoot: string } {
  const base = tempDir(name);
  const source = join(base, "src");
  const remote = join(base, "origin.git");
  const taskRoot = join(base, "tasks");
  mkdirSync(source, { recursive: true });
  if (options?.withRemote !== false) sh(base, "git", "init", "-q", "--bare", "origin.git");
  sh(source, "git", "init", "-q", "-b", "main");
  sh(source, "git", "config", "user.email", "test@example.invalid");
  sh(source, "git", "config", "user.name", "Test");
  writeFileSync(join(source, "README.md"), "init\n");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-qm", "init");
  if (options?.withRemote !== false) {
    sh(source, "git", "remote", "add", "origin", remote);
    sh(source, "git", "push", "-q", "-u", "origin", "main");
  }
  sh(source, "git", "checkout", "-qb", "side-work");
  return { source, taskRoot };
}

function worktreeCount(source: string): number {
  return sh(source, "git", "worktree", "list").split("\n").length;
}

describe("ensure_task_repo local-only repositories", () => {
  test("attaches an existing local task branch without resolving a remote", async () => {
    const { source, taskRoot } = makeSourceRepo("local-branch", { withRemote: false });
    sh(source, "git", "branch", "feat/local-task", "main");

    const r = await ensureTaskRepo(
      { branch: "feat/local-task", source_path: source },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("attached");
    expect((r as { branchSource: string }).branchSource).toBe("local");
    expect(sh(source, "git", "remote")).toBe("");
  });

  test("requires an explicit local base when the task branch and remotes are absent", async () => {
    const { source, taskRoot } = makeSourceRepo("local-no-base", { withRemote: false });
    const before = worktreeCount(source);

    const r = await ensureTaskRepo(
      { branch: "feat/local-task", source_path: source },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("base_selection_required");
    expect(String((r as { reason: string }).reason)).toContain("no remotes");
    expect(worktreeCount(source)).toBe(before);
    expect(sh(source, "git", "branch", "--list", "feat/local-task")).toBe("");
    expect(existsSync(taskRoot) ? readdirSync(taskRoot) : []).toEqual([]);
  });

  test("creates a task worktree from an explicit local base without fetching", async () => {
    const { source, taskRoot } = makeSourceRepo("local-base", { withRemote: false });
    const baseSha = sh(source, "git", "rev-parse", "main");

    const r = await ensureTaskRepo(
      { branch: "feat/local-task", source_path: source, base_ref: "main" },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("created");
    expect((r as { base: { ref: string; sha: string } }).base).toEqual({ ref: "main", sha: baseSha });
    expect((r as { headSha: string }).headSha).toBe(baseSha);
    expect(sh(source, "git", "remote")).toBe("");
  });

  test("rejects an unknown explicit remote before fetch or mutation", async () => {
    const { source, taskRoot } = makeSourceRepo("unknown-remote");
    const before = worktreeCount(source);

    const r = await ensureTaskRepo(
      { branch: "feat/missing", source_path: source, remote: "upstream" },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("error");
    expect(String((r as { message: string }).message)).toContain("Unknown remote upstream");
    expect(String((r as { message: string }).message)).toContain("origin");
    expect(worktreeCount(source)).toBe(before);
    expect(sh(source, "git", "branch", "--list", "feat/missing")).toBe("");
    expect(existsSync(taskRoot) ? readdirSync(taskRoot) : []).toEqual([]);
  });
});

describe("ensure_task_repo protected branches", () => {
  test.each(["main", "master", "develop"])("refuses %s as a canonical task branch", async (branch) => {
    const { source, taskRoot } = makeSourceRepo("prot-" + branch);
    const before = worktreeCount(source);

    const r = await ensureTaskRepo({ branch, source_path: source }, source, { taskRoot });

    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toContain("task branch");
    expect((r as { message: string }).message).toContain(branch);
    // Nothing was created or changed before the refusal.
    expect(worktreeCount(source)).toBe(before);
    expect(existsSync(taskRoot) ? readdirSync(taskRoot) : []).toEqual([]);
  });

  test("refuses a protected branch as a secondary lane branch", async () => {
    const { source, taskRoot } = makeSourceRepo("prot-lane");
    sh(source, "git", "branch", "feat/canonical", "main");
    const canonical = await ensureTaskRepo(
      { branch: "feat/canonical", source_path: source },
      source,
      { taskRoot },
    );
    expect(canonical.status).toBe("attached");
    const before = worktreeCount(source);

    const r = await ensureTaskRepo(
      { branch: "develop", source_path: source, task: "feat/canonical", slot: "backport" },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toContain("task branch");
    expect(worktreeCount(source)).toBe(before);
  });

  test("a normal task branch still works", async () => {
    const { source, taskRoot } = makeSourceRepo("normal");
    sh(source, "git", "branch", "feat/normal-task", "main");

    const r = await ensureTaskRepo(
      { branch: "feat/normal-task", source_path: source },
      source,
      { taskRoot },
    );

    expect(r.status).toBe("attached");
    expect((r as { branch: string }).branch).toBe("feat/normal-task");
    expect((r as { worktree: string }).worktree.startsWith(taskRoot)).toBe(true);
  });

  test("refusal covers names that merely contain a protected name (exact match only)", async () => {
    const { source, taskRoot } = makeSourceRepo("prefix");
    sh(source, "git", "branch", "develop-2", "main");

    const r = await ensureTaskRepo({ branch: "develop-2", source_path: source }, source, {
      taskRoot,
    });

    expect(r.status).toBe("attached");
  });
});
