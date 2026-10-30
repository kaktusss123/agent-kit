/**
 * teardown_task_repo tests: guarded teardown of whole canonical task
 * workspaces. Fail-closed guards first (dirty worktrees, branches checked
 * out outside the workspace, unmerged branches, unexpected layout, identity
 * traversal), then the full multi-repo teardown: worktrees unregistered
 * (non-force), branches deleted (non-force), workspace directory cleaned.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ensureTaskRepo, teardownTaskRepo } from "./flows";
import { taskWorkspacePath } from "./git";
import { acquireOwnerLease, releaseOwnerLease } from "./owner-lock";

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "teardown-"));
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

/** Local-only source repo off `main` with task branch(es) ready to attach.
 *  `dirName` controls the worktree directory name inside the workspace
 *  (basename of the repo root); two repos in ONE workspace need distinct
 *  basenames. */
function makeSourceRepo(name: string, branches: string[], dirName = "src"): string {
  const base = tempDir(name);
  const source = join(base, dirName);
  mkdirSync(source, { recursive: true });
  sh(source, "git", "init", "-q", "-b", "main");
  sh(source, "git", "config", "user.email", "test@example.invalid");
  sh(source, "git", "config", "user.name", "Test");
  writeFileSync(join(source, "README.md"), "init\n");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-qm", "init");
  for (const branch of branches) sh(source, "git", "branch", branch, "main");
  return source;
}

interface Built {
  taskRoot: string;
  workspace: string;
  repos: Record<string, { source: string; canonical: string }>;
}

/** A true multi-repo workspace: ONE task identity (task/multi) spanning
 *  two repositories — repoA canonical + lane, repoB canonical (the same
 *  branch name in repoB; worktree dirs differ by repo basename). */
async function buildMultiRepoWorkspace(name: string): Promise<Built> {
  const taskRoot = tempDir(name + "-tasks");
  const repoA = makeSourceRepo(name + "-a", ["task/multi", "feat/lane"]);
  const repoB = makeSourceRepo(name + "-b", ["task/multi"], "src-b");
  const canonicalA = await ensureTaskRepo(
    { branch: "task/multi", source_path: repoA },
    repoA,
    { taskRoot },
  );
  expect(canonicalA.status).toBe("attached");
  const laneA = await ensureTaskRepo(
    { branch: "feat/lane", source_path: repoA, task: "task/multi", slot: "backport" },
    repoA,
    { taskRoot },
  );
  expect(laneA.status).toBe("attached");
  const canonicalB = await ensureTaskRepo(
    { branch: "task/multi", source_path: repoB },
    repoB,
    { taskRoot },
  );
  expect(canonicalB.status).toBe("attached");
  return {
    taskRoot,
    workspace: taskWorkspacePath("task/multi", taskRoot),
    repos: {
      a: { source: repoA, canonical: (canonicalA as { worktree: string }).worktree },
      b: { source: repoB, canonical: (canonicalB as { worktree: string }).worktree },
    },
  };
}

describe("teardown_task_repo guards", () => {
  test("refuses an unknown task identity without touching anything", async () => {
    const taskRoot = tempDir("unknown-tasks");

    const r = await teardownTaskRepo({ task: "feat/nope" }, taskRoot, { taskRoot });

    expect(r.status).toBe("error");
    expect(String((r as { message: string }).message)).toContain("No task workspace");
  }, 60_000);

  test("refuses an identity that escapes the task root", async () => {
    const taskRoot = tempDir("escape-tasks");

    // "taskWorkspacePath" flattens slashes, so the only traversal vector is
    // the literal "..": join(taskRoot, "..") lands on the PARENT directory.
    const r = await teardownTaskRepo({ task: ".." }, taskRoot, { taskRoot });

    expect(r.status).toBe("error");
    expect(String((r as { message: string }).message)).toContain("does not resolve");
    expect(existsSync(dirname(taskRoot))).toBe(true);
  }, 60_000);

  test("refuses to remove a worktree with a live owner", async () => {
    const built = await buildMultiRepoWorkspace("owned");
    const lease = await acquireOwnerLease(built.taskRoot, realpathSync(built.repos.a.canonical));
    expect(lease.ok).toBe(true);
    try {
      const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
        taskRoot: built.taskRoot,
      });
      expect(r.status).toBe("owner_active");
      expect(existsSync(built.workspace)).toBe(true);
      expect(sh(built.repos.a.source, "git", "branch", "--list", "task/multi")).not.toBe("");
    } finally {
      if (lease.ok) releaseOwnerLease(lease.lease);
    }
    // Once the owner is gone the same teardown proceeds.
    const after = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });
    expect(after.status).toBe("torn_down");
    expect(existsSync(built.workspace)).toBe(false);
  }, 60_000);

  test("refuses dirty worktrees and removes nothing", async () => {
    const built = await buildMultiRepoWorkspace("dirty");
    writeFileSync(join(built.repos.a.canonical, "uncommitted.txt"), "wip\n");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("task_dirty");
    const dirty = (r as { dirty: { name: string; unstaged: string[] }[] }).dirty;
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.name).toBe("src");
    expect(dirty[0]!.unstaged).toEqual(["uncommitted.txt"]);
    // Nothing was removed.
    expect(existsSync(built.workspace)).toBe(true);
    expect(sh(built.repos.a.source, "git", "branch", "--list", "task/multi")).not.toBe("");
  }, 60_000);

  test("refuses a dirty secondary lane and removes nothing", async () => {
    const built = await buildMultiRepoWorkspace("dirty-lane");
    const lane = join(built.workspace, "src__backport");
    writeFileSync(join(lane, "staged.txt"), "wip\n");
    sh(lane, "git", "add", "staged.txt");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("task_dirty");
    const dirty = (r as { dirty: { name: string; staged: string[] }[] }).dirty;
    expect(dirty[0]!.name).toBe("src__backport");
    expect(dirty[0]!.staged).toEqual(["staged.txt"]);
    expect(existsSync(built.workspace)).toBe(true);
  }, 60_000);

  test("refuses a task branch checked out outside the workspace (branch_in_use)", async () => {
    const built = await buildMultiRepoWorkspace("in-use");
    // A forced duplicate checkout outside the workspace — the state a
    // bypass attempt leaves behind (git normally refuses duplicate
    // checkouts, worktree add --force does not).
    const duplicate = tempDir("in-use-dup") + "/dup";
    sh(built.repos.a.source, "git", "worktree", "add", "--force", duplicate, "task/multi");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("branch_in_use");
    const branches = (r as { branches: { branch: string; worktree: string }[] }).branches;
    // git reports worktree paths in real-path space (/var → /private/var
    // on macOS), so the expectation is stated in the same space.
    expect(branches).toEqual([{ branch: "task/multi", worktree: realpathSync(duplicate) }]);
    expect(existsSync(built.workspace)).toBe(true);
  }, 60_000);

  test("refuses unmerged branches (non-force) and removes nothing", async () => {
    const built = await buildMultiRepoWorkspace("unmerged");
    writeFileSync(join(built.repos.a.canonical, "work.txt"), "work\n");
    sh(built.repos.a.canonical, "git", "add", "work.txt");
    sh(built.repos.a.canonical, "git", "commit", "-qm", "task work");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("branch_unmerged");
    const branches = (r as { branches: { repo: string; branch: string; target: string }[] }).branches;
    expect(branches).toEqual([
      { repo: expect.any(String), branch: "task/multi", target: expect.any(String) },
    ]);
    // Nothing was removed.
    expect(existsSync(built.workspace)).toBe(true);
    expect(existsSync(built.repos.a.canonical)).toBe(true);
  }, 60_000);

  test("refuses a workspace layout ensure_task_repo does not create", async () => {
    const built = await buildMultiRepoWorkspace("layout");
    const nested = join(built.workspace, "someone-elses-clone");
    mkdirSync(nested, { recursive: true });
    sh(nested, "git", "init", "-q", "-b", "main");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("workspace_layout_rejected");
    expect((r as { nestedRepositories: string[] }).nestedRepositories).toEqual([
      "someone-elses-clone",
    ]);
    expect(existsSync(built.workspace)).toBe(true);
  }, 60_000);
});

describe("teardown_task_repo success", () => {
  test("tears down a multi-repo workspace fully: worktrees, branches, directory", async () => {
    const built = await buildMultiRepoWorkspace("happy");
    // Artifact files (session metadata) are removed with the workspace.
    writeFileSync(join(built.workspace, "report.md"), "session notes\n");

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("torn_down");
    const done = r as {
      task: string;
      workspace: string;
      artifacts: string[];
      repos: {
        repo: string;
        branches: string[];
        worktrees: { name: string; branch: string }[];
      }[];
    };
    expect(done.task).toBe("task/multi");
    expect(done.artifacts).toEqual(["report.md"]);
    expect(done.repos).toHaveLength(2);
    // The result's `repo` is the git common dir (the source repo's .git),
    // stated in real-path space.
    const commonDirOf = (source: string) => realpathSync(join(realpathSync(source), ".git"));
    const repoA = done.repos.find((x) => x.repo === commonDirOf(built.repos.a.source))!;
    expect(repoA.branches.sort()).toEqual(["feat/lane", "task/multi"]);
    expect(repoA.worktrees.map((w) => w.name).sort()).toEqual(["src", "src__backport"]);
    const repoB = done.repos.find((x) => x.repo === commonDirOf(built.repos.b.source))!;
    expect(repoB.branches).toEqual(["task/multi"]);
    expect(repoB.worktrees.map((w) => w.name)).toEqual(["src-b"]);

    // The workspace directory is gone and the task root is clean.
    expect(existsSync(built.workspace)).toBe(false);
    expect(readdirSync(built.taskRoot)).toEqual([]);

    // Branches are deleted (non-force) from each source repository.
    expect(sh(built.repos.a.source, "git", "branch", "--list", "task/multi")).toBe("");
    expect(sh(built.repos.a.source, "git", "branch", "--list", "feat/lane")).toBe("");
    expect(sh(built.repos.b.source, "git", "branch", "--list", "task/multi")).toBe("");

    // No worktree registrations remain in either repository.
    const listA = sh(built.repos.a.source, "git", "worktree", "list", "--porcelain");
    expect(listA).not.toContain(built.workspace);
    const listB = sh(built.repos.b.source, "git", "worktree", "list", "--porcelain");
    expect(listB).not.toContain(built.workspace);

    // The primary checkouts and their own branches are untouched.
    expect(sh(built.repos.a.source, "git", "branch", "--show-current")).toBe("main");
  }, 60_000);

  test("a rerun after a partial teardown finishes the job", async () => {
    const built = await buildMultiRepoWorkspace("rerun");
    // Simulate the documented partial state honestly: a manual git-side
    // worktree removal leaves repoB's branch behind with no worktree; the
    // rerun tears down what is still visible (repoA) and cleans the
    // workspace. A branch without a worktree is not discovered by design.
    sh(built.repos.b.source, "git", "worktree", "remove", built.repos.b.canonical);

    const r = await teardownTaskRepo({ task: "task/multi" }, built.taskRoot, {
      taskRoot: built.taskRoot,
    });

    expect(r.status).toBe("torn_down");
    expect(existsSync(built.workspace)).toBe(false);
    expect(readdirSync(built.taskRoot)).toEqual([]);
    // repoA (still visible) is fully torn down...
    expect(sh(built.repos.a.source, "git", "branch", "--list", "task/multi")).toBe("");
    // ...while repoB's orphaned branch is left alone (reported by the caller
    // via task_status, removable with a plain non-force branch -d).
    expect(sh(built.repos.b.source, "git", "branch", "--list", "task/multi")).not.toBe("");
  }, 60_000);
});
