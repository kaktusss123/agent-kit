/**
 * task_status workspace scan: per-worktree Git facts, common-dir resolution,
 * and the facts scope (full facts only for worktrees of the requested
 * repository). Real temporary repositories; TMPDIR must be outside any Git
 * tree so the "outside git" request really is outside.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import {
  getWorktreeGitFacts,
  linkedWorktreeFacts,
  parseBranchStatus,
  scanTaskWorkspaces,
} from "./git.ts";
import { taskStatus } from "./flows.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "scan@example.invalid");
  sh(dir, "config", "user.name", "Scan");
  writeFileSync(join(dir, "README.md"), "init\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-qm", "init");
}

function gitCommonDir(worktree: string): string {
  const out = sh(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return realpathSync(out);
}

describe("task_status scan", () => {
  let base: string;
  let outside: string;
  let taskRoot: string;
  let repoA: string;
  let repoB: string;
  let wsOne: string;
  let wsTwo: string;
  let headA: string;
  let headB: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ak-status-scan-")));
    outside = join(base, "outside");
    mkdirSync(outside);
    taskRoot = join(base, "tasks");
    repoA = join(base, "repo-a");
    repoB = join(base, "repo-b");
    const remote = join(base, "remote-a.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    initRepo(repoA);
    initRepo(repoB);
    sh(repoA, "remote", "add", "origin", remote);
    sh(repoA, "push", "-q", "origin", "main");

    wsOne = join(taskRoot, "feat~2Fone");
    wsTwo = join(taskRoot, "feat~2Ftwo");
    // feat/one: repo A canonical (tracked, dirty), repo A lane (detached),
    // repo B canonical (no upstream).
    sh(repoA, "worktree", "add", "-q", "-b", "feat/one", join(wsOne, "a"), "main");
    sh(join(wsOne, "a"), "push", "-q", "-u", "origin", "feat/one");
    sh(repoA, "worktree", "add", "-q", "--detach", join(wsOne, "a__lane"), "main");
    sh(repoB, "worktree", "add", "-q", "-b", "feat/one", join(wsOne, "b"), "main");
    writeFileSync(join(wsOne, "SPEC.md"), "spec\n");
    // feat/two: repo B only, clean.
    sh(repoB, "worktree", "add", "-q", "-b", "feat/two", join(wsTwo, "b"), "main");

    const a = join(wsOne, "a");
    writeFileSync(join(a, "README.md"), "staged\n");
    sh(a, "add", "README.md");
    writeFileSync(join(a, "README.md"), "staged then unstaged\n");
    writeFileSync(join(a, "new.txt"), "untracked\n");

    headA = sh(repoA, "rev-parse", "main");
    headB = sh(repoB, "rev-parse", "main");
  });

  after(() => rmSync(base, { recursive: true, force: true }));

  const clean = { staged: [], unstaged: [] };

  test("without a repository target every worktree gets full facts", async () => {
    const status = await taskStatus({}, outside, { taskRoot });
    expect(status.classification).toBe("OUTSIDE_GIT");
    expect(status.factsScope).toBe("all");
    const byPath = new Map(
      status.taskWorkspaces.flatMap((ws) => ws.repos.map((r) => [r.path, r] as const)),
    );
    expect(byPath.get(join(wsOne, "a"))).toMatchObject({
      facts: "full",
      kind: "canonical",
      slot: null,
      branch: "feat/one",
      headSha: headA,
      upstream: "origin/feat/one",
      dirty: { staged: ["README.md"], unstaged: ["README.md", "new.txt"] },
    });
    expect(byPath.get(join(wsOne, "a__lane"))).toMatchObject({
      facts: "full",
      kind: "lane",
      slot: "lane",
      branch: "",
      headSha: headA,
      upstream: null,
      dirty: clean,
    });
    expect(byPath.get(join(wsOne, "b"))).toMatchObject({
      facts: "full",
      branch: "feat/one",
      headSha: headB,
      upstream: null,
      dirty: clean,
    });
    expect(byPath.get(join(wsTwo, "b"))).toMatchObject({
      facts: "full",
      branch: "feat/two",
      headSha: headB,
      upstream: null,
      dirty: clean,
    });
  });

  test("a repository target gets full facts only for its own worktrees", async () => {
    const status = await taskStatus({ path: join(wsOne, "a__lane") }, outside, { taskRoot });
    expect(status.classification).toBe("MANAGED_TASK_WORKTREE");
    expect(status.factsScope).toEqual({ commonDir: realpathSync(join(repoA, ".git")) });
    const one = status.taskWorkspaces.find((ws) => ws.workspace === wsOne)!;
    const two = status.taskWorkspaces.find((ws) => ws.workspace === wsTwo)!;
    // Every workspace and repo stays listed (ticket discovery needs them).
    expect(one.artifacts).toEqual(["SPEC.md"]);
    expect(one.repos.find((r) => r.name === "a")).toMatchObject({
      facts: "full",
      branch: "feat/one",
      upstream: "origin/feat/one",
    });
    expect(one.repos.find((r) => r.name === "a__lane")).toMatchObject({ facts: "full", headSha: headA });
    for (const omitted of [one.repos.find((r) => r.name === "b")!, two.repos[0]!]) {
      expect(omitted).toMatchObject({
        facts: "omitted",
        kind: "canonical",
        slot: null,
        classification: "MANAGED_TASK_WORKTREE",
      });
      expect(omitted.owner).toMatchObject({ state: "free" });
      for (const field of ["branch", "headSha", "upstream", "dirty"]) {
        expect(field in omitted, field).toBe(false);
      }
    }
  });

  test("the primary checkout scopes facts to its repository too", async () => {
    const status = await taskStatus({ path: repoB }, outside, { taskRoot });
    expect(status.factsScope).toEqual({ commonDir: realpathSync(join(repoB, ".git")) });
    const facts = status.taskWorkspaces.flatMap((ws) => ws.repos.map((r) => [r.path, r.facts]));
    expect(facts).toEqual([
      [join(wsOne, "a"), "omitted"],
      [join(wsOne, "a__lane"), "omitted"],
      [join(wsOne, "b"), "full"],
      [join(wsTwo, "b"), "full"],
    ]);
  });

  test("order follows directory listing order, independent of probe completion", async () => {
    const scan = await scanTaskWorkspaces(taskRoot);
    const expected = readdirSync(taskRoot).flatMap((ws) =>
      readdirSync(join(taskRoot, ws))
        .filter((name) => !name.endsWith(".md"))
        .map((name) => [ws, name]),
    );
    expect(scan.flatMap((ws) => ws.repos.map((r) => [ws.key, r.name]))).toEqual(expected);
  });

  test("common dir from the .git pointer files equals Git's own answer", async () => {
    const facts = await linkedWorktreeFacts(wsOne);
    expect(facts.map((f) => f.name)).toEqual(["a", "a__lane", "b"]);
    for (const fact of facts) {
      expect(fact.commonDir, fact.name).toBe(gitCommonDir(fact.path));
    }
  });

  test("a relative gitdir pointer resolves against the worktree", async () => {
    const dir = join(base, "relative-ws");
    const wt = join(dir, "rel");
    sh(repoB, "worktree", "add", "-q", "--detach", wt, "main");
    const gitdir = join(repoB, ".git", "worktrees", "rel");
    writeFileSync(join(wt, ".git"), `gitdir: ${join("..", "..", "repo-b", ".git", "worktrees", "rel")}\n`);
    expect(realpathSync(join(wt, "..", "..", "repo-b", ".git", "worktrees", "rel"))).toBe(realpathSync(gitdir));
    const [fact] = await linkedWorktreeFacts(dir);
    expect(fact!.commonDir).toBe(gitCommonDir(wt));
    expect(fact!.commonDir).toBe(realpathSync(join(repoB, ".git")));
  });

  test("a dangling gitdir pointer degrades to an unknown common dir", async () => {
    const dir = join(base, "dangling-ws");
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", ".git"), "gitdir: /nonexistent/worktrees/broken\n");
    expect(await linkedWorktreeFacts(dir)).toEqual([
      { name: "broken", path: join(dir, "broken"), commonDir: null },
    ]);
  });

  test("a configured upstream whose remote branch is gone is still reported", async () => {
    const wt = join(base, "gone-ws", "a");
    sh(repoA, "worktree", "add", "-q", "-b", "feat/gone", wt, "main");
    sh(wt, "push", "-q", "-u", "origin", "feat/gone");
    sh(wt, "push", "-q", "origin", "--delete", "feat/gone");
    sh(wt, "fetch", "-q", "--prune", "origin");
    expect(sh(wt, "for-each-ref", "--format=%(upstream:short)", "refs/heads/feat/gone")).toBe("origin/feat/gone");
    expect(await getWorktreeGitFacts(wt)).toEqual({
      branch: "feat/gone",
      headSha: headA,
      upstream: "origin/feat/gone",
      dirty: clean,
    });
  });

  test("an unreadable worktree degrades to empty facts", async () => {
    expect(await getWorktreeGitFacts(join(base, "missing"))).toEqual({
      branch: "",
      headSha: "",
      upstream: null,
      dirty: clean,
    });
  });
});

describe("parseBranchStatus", () => {
  test("header lines map to branch, sha, upstream; entries to dirty state", () => {
    const out = [
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +1 -0",
      "1 M. N... 100644 100644 100644 aaa bbb staged file.txt",
      "? new file.txt",
    ].join("\n");
    expect(parseBranchStatus(out)).toEqual({
      branch: "feat/x",
      headSha: "1111111111111111111111111111111111111111",
      upstream: "origin/feat/x",
      dirty: { staged: ["staged file.txt"], unstaged: ["new file.txt"] },
    });
  });

  test("detached HEAD and an unborn branch keep the empty-string conventions", () => {
    expect(
      parseBranchStatus("# branch.oid 2222222222222222222222222222222222222222\n# branch.head (detached)"),
    ).toEqual({
      branch: "",
      headSha: "2222222222222222222222222222222222222222",
      upstream: null,
      dirty: { staged: [], unstaged: [] },
    });
    expect(parseBranchStatus("# branch.oid (initial)\n# branch.head main")).toEqual({
      branch: "main",
      headSha: "",
      upstream: null,
      dirty: { staged: [], unstaged: [] },
    });
  });
});
