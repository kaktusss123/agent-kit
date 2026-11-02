/**
 * Task workspace identity → directory name.
 *
 * Two different task identities must never share one directory, otherwise a
 * second RepoOwner can be dispatched into another task's worktree. The
 * oldest mapping (slashes flattened to "_") made `feat/a_b` and `feat/a/b`
 * the same directory; the previous mapping escaped with `%2F`, which is a
 * valid directory name but not a valid Node ESM module path
 * (`ERR_INVALID_MODULE_SPECIFIER: ... must not include encoded "/"`). This
 * suite pins the current `~2F` spelling, the identity round trip, the lookup
 * chain through the older spellings, and the module-loading regression.
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
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { ensureTaskRepo, taskStatus, teardownTaskRepo } from "./flows.ts";
import {
  legacyTaskWorkspacePath,
  percentTaskWorkspacePath,
  resolveTaskWorkspacePath,
  taskWorkspaceIdentity,
  taskWorkspacePath,
} from "./git.ts";
import {
  decodeTaskWorkspaceName,
  encodeTaskWorkspaceName,
  legacyTaskWorkspaceName,
  percentTaskWorkspaceName,
  taskWorkspaceLayout,
} from "./workspace-path.ts";

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
    const identities = ["feat/a_b", "feat/a/b", "feat/a%2Fb", "feat/a#b"];
    const names = identities.map(encodeTaskWorkspaceName);
    expect(new Set(names).size).toBe(identities.length);
    // The historical flattening is what used to collapse them.
    expect(legacyTaskWorkspaceName("feat/a_b")).toBe(
      legacyTaskWorkspaceName("feat/a/b"),
    );
    // The previous encoding is also injective, so the chain stays unambiguous.
    const percentNames = identities.map(percentTaskWorkspaceName);
    expect(new Set(percentNames).size).toBe(identities.length);
    expect(taskWorkspaceLayout("feat/a_b").directory).toBe("feat~2Fa_b");
    expect(taskWorkspaceLayout("feat/a/b").directory).toBe("feat~2Fa~2Fb");
  });

  test("an identity without escaped characters keeps its historical name", () => {
    for (const identity of ["feat-x", "refactor_AK-03_worktree_ownership", "a.b"]) {
      expect(encodeTaskWorkspaceName(identity)).toBe(identity);
      expect(taskWorkspaceLayout(identity).legacyDirectory).toBeNull();
      expect(taskWorkspaceLayout(identity).percentDirectory).toBeNull();
    }
  });

  test("encoding round-trips through the directory name", () => {
    const identities = [
      "feat/x",
      "feat/a_b",
      "fix/crew_bay_starting_identity",
      "feat/a%2Fb",
      "feat/a#b",
      "100%",
      "chore/a\\b",
      "a/b/c",
      "feat/x#y%z",
      "feature/with-hyphen.and.dot",
      "a b",
      "why?",
    ];
    for (const identity of identities) {
      const name = encodeTaskWorkspaceName(identity);
      expect(decodeTaskWorkspaceName(name)).toBe(identity);
      expect(taskWorkspaceIdentity(name)).toBe(identity);
    }
  });

  test("the previous `%`-escaping still round-trips", () => {
    for (const identity of ["feat/x", "feat/a%2Fb", "chore/a\\b", "a/b/c"]) {
      const name = percentTaskWorkspaceName(identity);
      expect(decodeTaskWorkspaceName(name)).toBe(identity);
      expect(decodeTaskWorkspaceName(percentTaskWorkspaceName(identity))).toBe(identity);
    }
  });

  test("identity is recovered from each directory spelling", () => {
    // Current, previous, oldest: all three are readable names of one identity
    // except the flattened one, which can only claim itself.
    expect(taskWorkspaceIdentity("feat~2Fwork")).toBe("feat/work");
    expect(taskWorkspaceIdentity("feat%2Fwork")).toBe("feat/work");
    expect(taskWorkspaceIdentity("feat_work")).toBe("feat_work");
    expect(taskWorkspaceIdentity("feat-a")).toBe("feat-a");
  });

  test("a name this encoding did not produce stays readable as itself", () => {
    // Pre-encoding directories were flattened: no escape, decoded verbatim.
    expect(decodeTaskWorkspaceName("feat_a_b")).toBe("feat_a_b");
    expect(decodeTaskWorkspaceName("feat_host2")).toBe("feat_host2");
    // A foreign escape sequence is not silently decoded.
    expect(decodeTaskWorkspaceName("feat%20x")).toBe("feat%20x");
    expect(decodeTaskWorkspaceName("a%2fb")).toBe("a%2fb");
    expect(decodeTaskWorkspaceName("a~2fb")).toBe("a~2fb");
    expect(decodeTaskWorkspaceName("a~zzb")).toBe("a~zzb");
    // A literal escape spelling that our encoder would have escaped instead.
    expect(decodeTaskWorkspaceName("a%~2Fb")).toBe("a%~2Fb");
  });

  test("the encoded directory stays in a loader-safe alphabet", () => {
    const identities = [
      "feat/a b",
      "feat/a#b",
      "feat/a%2Fb",
      "chore/a\\b",
      "why?",
      "a/b/c",
      "100%",
    ];
    for (const identity of identities) {
      const name = encodeTaskWorkspaceName(identity);
      for (const forbidden of ["%", "#", "?", " ", "\\"]) {
        expect(name).not.toContain(forbidden);
      }
      expect(name).toMatch(/^[A-Za-z0-9._~-]+$/);
    }
  });

  test("the encoded directory never contains a path separator or traversal", () => {
    for (const identity of ["feat/x", "..", "../escape", "a/../../b", "/abs/path"]) {
      const name = encodeTaskWorkspaceName(identity);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      if (identity !== "..") expect(name).not.toBe("..");
    }
  });

  test("resolution walks current, then previous, then historical spelling", () => {
    const taskRoot = tempDir("resolve");
    const identity = "feat/legacy";
    const current = taskWorkspacePath(identity, taskRoot);
    const percent = percentTaskWorkspacePath(identity, taskRoot)!;
    const legacy = legacyTaskWorkspacePath(identity, taskRoot)!;
    expect(new Set([current, percent, legacy]).size).toBe(3);
    // Nothing exists yet: the creation target is the current (`~`) directory.
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(current);
    // The historically flattened directory is still found.
    mkdirSync(legacy, { recursive: true });
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(legacy);
    // The already-deployed `%` directory wins over the flattened one.
    mkdirSync(percent, { recursive: true });
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(percent);
    // The current spelling wins once it exists.
    mkdirSync(current, { recursive: true });
    expect(resolveTaskWorkspacePath(identity, taskRoot)).toBe(current);
  });

  test("older spellings are never creation targets", () => {
    const taskRoot = tempDir("create-target");
    // `feat/current` has both older names; a fresh identity does not.
    expect(resolveTaskWorkspacePath("feat/new", taskRoot)).toBe(
      join(taskRoot, encodeTaskWorkspaceName("feat/new")),
    );
    expect(percentTaskWorkspacePath("feat/new", taskRoot)).toBe(
      join(taskRoot, percentTaskWorkspaceName("feat/new")),
    );
    expect(legacyTaskWorkspacePath("feat/new", taskRoot)).toBe(
      join(taskRoot, legacyTaskWorkspaceName("feat/new")),
    );
  });

  test("escaped characters cannot collide with each other", () => {
    // `%2F` as literal identity text must not decode like a separator.
    expect(encodeTaskWorkspaceName("a%2Fb")).toBe("a~252Fb");
    expect(decodeTaskWorkspaceName("a~252Fb")).toBe("a%2Fb");
    expect(encodeTaskWorkspaceName("a#b")).toBe("a~23b");
    expect(encodeTaskWorkspaceName("a~b")).toBe("a~7Eb");
  });

  test("slash-free identities have no separate older paths", () => {
    expect(legacyTaskWorkspacePath("feat-x", "/tmp/root")).toBeNull();
    expect(percentTaskWorkspacePath("feat-x", "/tmp/root")).toBeNull();
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
  });

  test("task_status reads identities from all three directory spellings", async () => {
    const { source, taskRoot } = makeSourceRepo("spellings");
    const layouts: [string, string][] = [
      ["feat/current", encodeTaskWorkspaceName("feat/current")],
      ["feat/previous", percentTaskWorkspaceName("feat/previous")],
      ["feat/old", legacyTaskWorkspaceName("feat/old")],
    ];
    for (const [branch, directory] of layouts) {
      sh(source, "git", "branch", branch);
      mkdirSync(join(taskRoot, directory), { recursive: true });
      sh(source, "git", "worktree", "add", "-q", join(taskRoot, directory, "src"), branch);
    }

    const status = await taskStatus({}, source, { taskRoot });
    const identityByKey = new Map(
      status.taskWorkspaces.map((w) => [w.key, w.identity]),
    );
    expect(identityByKey.get(encodeTaskWorkspaceName("feat/current"))).toBe("feat/current");
    expect(identityByKey.get(percentTaskWorkspaceName("feat/previous"))).toBe(
      "feat/previous",
    );
    // The flattening cannot say which identity it was, so it reports itself.
    expect(identityByKey.get(legacyTaskWorkspaceName("feat/old"))).toBe("feat_old");
  });

  test("a previous-layout directory is reused when it provably holds the branch", async () => {
    const { source, taskRoot } = makeSourceRepo("percent-reuse");
    sh(source, "git", "branch", "feat/percent");
    const percentWs = join(taskRoot, percentTaskWorkspaceName("feat/percent"));
    mkdirSync(percentWs, { recursive: true });
    sh(source, "git", "worktree", "add", "-q", join(percentWs, "src"), "feat/percent");

    const result = await ensureTaskRepo(
      { branch: "feat/percent", source_path: source },
      source,
      { taskRoot },
    );

    expect(result).toMatchObject({
      status: "reused",
      worktree: join(percentWs, "src"),
      layout: "percent",
    });
    // Nothing was renamed, moved, or duplicated.
    expect(readdirSync(taskRoot)).toEqual([percentTaskWorkspaceName("feat/percent")]);
    expect(existsSync(taskWorkspacePath("feat/percent", taskRoot))).toBe(false);
  });

  test("a previous-layout directory of another branch is never taken over", async () => {
    const { source, taskRoot } = makeSourceRepo("percent-occupied");
    sh(source, "git", "branch", "feat/a_b");
    sh(source, "git", "branch", "feat/a/b");
    // `feat/a/b`'s previous `%` name equals `feat/a_b`'s directory.
    const occupied = join(taskRoot, percentTaskWorkspaceName("feat/a_b"));
    mkdirSync(occupied, { recursive: true });
    sh(source, "git", "worktree", "add", "-q", join(occupied, "src"), "feat/a_b");

    const result = await ensureTaskRepo(
      { branch: "feat/a/b", source_path: source },
      source,
      { taskRoot },
    );

    // A new, distinct directory; the occupied one is untouched.
    expect(result).toMatchObject({
      status: "attached",
      worktree: join(taskRoot, encodeTaskWorkspaceName("feat/a/b"), "src"),
    });
    expect(existsSync(taskWorkspacePath("feat/a/b", taskRoot))).toBe(true);
    expect(sh(join(occupied, "src"), "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/a_b",
    );
  });

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
  });

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
      worktree: join(taskRoot, encodeTaskWorkspaceName("feat/a/b"), "src"),
    });
    expect(sh(join(legacyWs, "src"), "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/a_b",
    );
  });

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
  });

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
  });
});
