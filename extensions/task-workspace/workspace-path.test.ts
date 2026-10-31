/**
 * Task workspace identity → directory name.
 *
 * Two different task identities must never share one directory, otherwise a
 * second RepoOwner can be dispatched into another task's worktree. The old
 * mapping (slashes flattened to "_") made `feat/a_b` and `feat/a/b` the same
 * directory; this suite pins the reversible replacement, the identity round
 * trip, and the behaviour for directories written by the old layout.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ensureTaskRepo, taskStatus, teardownTaskRepo } from "./flows";
import {
  legacyTaskWorkspacePath,
  resolveTaskWorkspacePath,
  taskWorkspaceIdentity,
  taskWorkspacePath,
} from "./git";
import {
  decodeTaskWorkspaceName,
  encodeTaskWorkspaceName,
  legacyTaskWorkspaceName,
  taskWorkspaceLayout,
} from "./workspace-path";

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "ws-path-"));
  const dir = join(rootDir, `${prefix}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

function sh(cwd: string, ...cmd: string[]): string {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" }).trim();
}

function makeSourceRepo(name: string): { source: string; taskRoot: string } {
  const base = tempDir(name);
  const source = join(base, "src");
  const remote = join(base, "origin.git");
  const taskRoot = join(base, "tasks");
  mkdirSync(source, { recursive: true });
  sh(base, "git", "init", "-q", "--bare", "origin.git");
  sh(source, "git", "init", "-q", "-b", "main");
  sh(source, "git", "config", "user.email", "test@example.invalid");
  sh(source, "git", "config", "user.name", "Test");
  writeFileSync(join(source, "README.md"), "init\n");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-qm", "init");
  sh(source, "git", "remote", "add", "origin", remote);
  sh(source, "git", "push", "-q", "-u", "origin", "main");
  sh(remote, "git", "symbolic-ref", "HEAD", "refs/heads/main");
  return { source, taskRoot };
}

describe("task workspace name encoding", () => {
  test("distinct identities never share a directory name", () => {
    expect(encodeTaskWorkspaceName("feat/a_b")).not.toBe(
      encodeTaskWorkspaceName("feat/a/b"),
    );
    // The historical flattening is what used to collapse them.
    expect(legacyTaskWorkspaceName("feat/a_b")).toBe(
      legacyTaskWorkspaceName("feat/a/b"),
    );
    expect(taskWorkspaceLayout("feat/a_b").directory).toBe("feat%2Fa_b");
    expect(taskWorkspaceLayout("feat/a/b").directory).toBe("feat%2Fa%2Fb");
  });

  test("an identity without separators keeps its historical directory name", () => {
    for (const identity of ["feat-x", "refactor_AK-03_worktree_ownership", "a.b"]) {
      expect(encodeTaskWorkspaceName(identity)).toBe(identity);
      expect(taskWorkspaceLayout(identity).legacyDirectory).toBeNull();
    }
  });

  test("encoding round-trips through the directory name", () => {
    const identities = [
      "feat/x",
      "feat/a_b",
      "feat/x%2Fy",
      "chore/a\\b",
      "a/b/c",
      "100%",
      "feature/with-hyphen.and.dot",
    ];
    for (const identity of identities) {
      const name = encodeTaskWorkspaceName(identity);
      expect(decodeTaskWorkspaceName(name)).toBe(identity);
      expect(taskWorkspaceIdentity(name)).toBe(identity);
    }
  });

  test("a name this encoding did not produce stays readable as itself", () => {
    // Pre-encoding directories were flattened: no escape, decoded verbatim.
    expect(decodeTaskWorkspaceName("feat_a_b")).toBe("feat_a_b");
    expect(decodeTaskWorkspaceName("feat_host2")).toBe("feat_host2");
    // A foreign escape sequence is not silently decoded.
    expect(decodeTaskWorkspaceName("feat%20x")).toBe("feat%20x");
    expect(decodeTaskWorkspaceName("a%2fb")).toBe("a%2fb");
  });

  test("the encoded directory never contains a path separator or traversal", () => {
    for (const identity of ["feat/x", "..", "../escape", "a/../../b", "/abs/path"]) {
      const name = encodeTaskWorkspaceName(identity);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      if (identity !== "..") expect(name).not.toBe("..");
    }
  });

  test("resolution prefers the identity's own directory, then a pre-encoding one", () => {
    const taskRoot = tempDir("resolve");
    const identity = "feat/legacy";
    const current = taskWorkspacePath(identity, taskRoot);
    const legacy = legacyTaskWorkspacePath(identity, taskRoot)!;
    expect(current).not.toBe(legacy);
    // Nothing exists yet: the creation target is the encoded directory.
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(current);
    // A pre-encoding directory is still found (no rename, no takeover).
    mkdirSync(legacy, { recursive: true });
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(legacy);
    // The identity's own directory wins once it exists.
    mkdirSync(current, { recursive: true });
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(current);
  });

  test("slash-free identities have no separate legacy path", () => {
    expect(legacyTaskWorkspacePath("feat-x", "/tmp/root")).toBeNull();
  });
});

describe("task workspace directories for colliding branch names", () => {
  test("two branches that used to share one directory now get two", async () => {
    const { source, taskRoot } = makeSourceRepo("collide");
    sh(source, "git", "branch", "feat/a_b");
    sh(source, "git", "branch", "feat/a/b");

    const first = await ensureTaskRepo(
      { branch: "feat/a_b", source_path: source },
      source,
      { taskRoot },
    );
    const second = await ensureTaskRepo(
      { branch: "feat/a/b", source_path: source },
      source,
      { taskRoot },
    );

    expect(first).toMatchObject({ status: "attached" });
    expect(second).toMatchObject({ status: "attached" });
    const firstPath = (first as { worktree: string }).worktree;
    const secondPath = (second as { worktree: string }).worktree;
    expect(firstPath).not.toBe(secondPath);
    expect(sh(firstPath, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/a_b");
    expect(sh(secondPath, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/a/b");
    // Both workspaces are listed as separate tasks.
    const status = await taskStatus({}, source, { taskRoot });
    expect(status.taskWorkspaces.map((w) => w.workspace).sort()).toEqual(
      [dirname(firstPath), dirname(secondPath)].sort(),
    );
    expect(status.taskWorkspaces.map((w) => w.identity).sort()).toEqual([
      "feat/a/b",
      "feat/a_b",
    ]);
  }, 60_000);

  test("a pre-encoding directory is reused when it provably holds the branch", async () => {
    const { source, taskRoot } = makeSourceRepo("legacy-reuse");
    sh(source, "git", "branch", "feat/legacy");
    // Simulate a workspace created by the old flattening.
    const legacyWs = join(taskRoot, "feat_legacy");
    mkdirSync(legacyWs, { recursive: true });
    sh(source, "git", "worktree", "add", "-q", join(legacyWs, "src"), "feat/legacy");

    const result = await ensureTaskRepo(
      { branch: "feat/legacy", source_path: source },
      source,
      { taskRoot },
    );

    expect(result).toMatchObject({
      status: "reused",
      worktree: join(legacyWs, "src"),
      layout: "legacy",
    });
    // Nothing was renamed or duplicated.
    expect(readdirSync(taskRoot)).toEqual(["feat_legacy"]);
  }, 60_000);

  test("a pre-encoding directory of another branch is never taken over", async () => {
    const { source, taskRoot } = makeSourceRepo("legacy-occupied");
    sh(source, "git", "branch", "feat/a_b");
    sh(source, "git", "branch", "feat/a/b");
    // `feat/a/b`'s old directory is occupied by `feat/a_b`.
    const legacyWs = join(taskRoot, "feat_a_b");
    mkdirSync(legacyWs, { recursive: true });
    sh(source, "git", "worktree", "add", "-q", join(legacyWs, "src"), "feat/a_b");

    const result = await ensureTaskRepo(
      { branch: "feat/a/b", source_path: source },
      source,
      { taskRoot },
    );

    // A new, distinct directory; the occupied one is untouched.
    expect(result).toMatchObject({
      status: "attached",
      worktree: join(taskRoot, "feat%2Fa%2Fb", "src"),
    });
    expect(sh(join(legacyWs, "src"), "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/a_b",
    );
  }, 60_000);

  test("an identity whose own name is squatted by another branch refuses", async () => {
    const { source, taskRoot } = makeSourceRepo("legacy-squat");
    sh(source, "git", "branch", "feat_a_b");
    // The pre-encoding name of `feat/a/b` IS the identity's own directory name.
    const squat = join(taskRoot, "feat_a_b");
    mkdirSync(squat, { recursive: true });
    sh(source, "git", "branch", "feat/a/b");
    sh(source, "git", "worktree", "add", "-q", join(squat, "src"), "feat/a/b");

    const result = await ensureTaskRepo(
      { branch: "feat_a_b", source_path: source },
      source,
      { taskRoot },
    );

    expect(result).toMatchObject({ status: "error" });
    expect(String((result as { message: string }).message)).toContain("not feat_a_b");
    // Nothing removed, nothing renamed: the other branch keeps its worktree.
    expect(sh(join(squat, "src"), "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/a/b",
    );
  }, 60_000);

  test("teardown resolves a pre-encoding directory by its flat name and by identity", async () => {
    for (const task of ["feat_old", "feat/old"]) {
      const { source, taskRoot } = makeSourceRepo(`teardown-${task.replace(/[^a-z]/g, "")}`);
      sh(source, "git", "branch", "feat/old");
      const legacyWs = join(taskRoot, "feat_old");
      mkdirSync(legacyWs, { recursive: true });
      sh(source, "git", "worktree", "add", "-q", join(legacyWs, "src"), "feat/old");

      const result = await teardownTaskRepo({ task }, source, { taskRoot });
      expect(result).toMatchObject({ status: "torn_down", workspace: legacyWs });
      expect(existsSync(legacyWs)).toBe(false);
    }
  }, 60_000);
});
