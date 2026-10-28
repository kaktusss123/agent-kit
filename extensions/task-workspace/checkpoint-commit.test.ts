/**
 * checkpoint_commit regression tests — real git repositories, real hooks.
 *
 * The contract under test: the created commit contains exactly the intended
 * path set. Pre-commit hooks may adjust the index they run against (and Git
 * commits that adjusted index — even `commit --only` picks up hook-staged
 * files, verified on git 2.47), so a successful hook can silently broaden
 * the commit scope. The tool must detect that after the commit exists and
 * fail closed as `commit_scope_mismatch` instead of reporting `committed`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { checkpointCommit } from "./flows";

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "checkpoint-commit-"));
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

/** A plain (primary-checkout) git repo; commits pass allow_primary=true. */
function makeRepo(name: string): string {
  const repo = tempDir(name);
  sh(repo, "git", "init", "-q", "-b", "main");
  sh(repo, "git", "config", "user.email", "test@example.invalid");
  sh(repo, "git", "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-qm", "init");
  return repo;
}

function setHook(repo: string, script: string): void {
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n" + script);
  sh(repo, "chmod", "+x", ".git/hooks/pre-commit");
}

function commitFiles(repo: string): string[] {
  // --diff-merges=first-parent: a merge commit's own change set is the diff
  // against its first parent (plain diff-tree prints nothing for merges).
  return sh(repo, "git", "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-merges=first-parent", "HEAD")
    .split("\n")
    .filter((f) => f)
    .sort();
}

const OPTS = { taskRoot: tempDir("unused-root") };

async function commit(repo: string, paths: string[], message = "test checkpoint") {
  return checkpointCommit({ repo, paths, message, allow_primary: true }, repo, OPTS);
}

describe("checkpoint_commit exact scope", () => {
  test("commits exactly the intended set: additions, modification, multiple paths", async () => {
    const repo = makeRepo("baseline");
    writeFileSync(join(repo, "new1.txt"), "1\n");
    writeFileSync(join(repo, "new2.txt"), "2\n");
    writeFileSync(join(repo, "base.txt"), "changed\n");

    const r = await commit(repo, ["new1.txt", "new2.txt", "base.txt"]);

    expect(r.status).toBe("committed");
    expect(commitFiles(repo)).toEqual(["base.txt", "new1.txt", "new2.txt"]);
    expect((r as { files: string[] }).files.sort()).toEqual(["base.txt", "new1.txt", "new2.txt"]);
    expect((r as { remainingDirty: string[] }).remainingDirty).toEqual([]);
  });

  test("hook-staged extra file cannot enter the commit — fail closed as commit_scope_mismatch", async () => {
    const repo = makeRepo("hook-add");
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    setHook(repo, "echo generated > generated.txt\ngit add generated.txt\nexit 0\n");

    const r = await commit(repo, ["a.txt"]);

    expect(r.status).toBe("commit_scope_mismatch");
    const scope = r as { commit: string; intended: string[]; actual: string[] };
    expect(scope.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(scope.intended).toEqual(["a.txt"]);
    expect(scope.actual).toEqual(["a.txt", "generated.txt"]);
    // The commit does exist — the tool reports the fact instead of success.
    expect(commitFiles(repo)).toEqual(["a.txt", "generated.txt"]);
  });

  test("hook-modified intended file (staged by the hook) commits with exact scope", async () => {
    const repo = makeRepo("hook-modify-intended");
    writeFileSync(join(repo, "a.txt"), "unformatted\n");
    // sed -i with an explicit backup suffix works on both GNU and BSD sed.
    setHook(repo, "sed -i.bak 's/unformatted/formatted/' a.txt && rm -f a.txt.bak\ngit add a.txt\nexit 0\n");

    const r = await commit(repo, ["a.txt"]);

    expect(r.status).toBe("committed");
    expect(commitFiles(repo)).toEqual(["a.txt"]);
    expect(sh(repo, "git", "show", "HEAD:a.txt")).toBe("formatted");
  });

  test("failing hook that staged extras → commit_failed, then ambiguous_staged on retry", async () => {
    const repo = makeRepo("hook-add-fail");
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    setHook(repo, "echo generated > generated.txt\ngit add generated.txt\nexit 1\n");

    const first = await commit(repo, ["a.txt"]);
    expect(first.status).toBe("commit_failed");
    expect((first as { staged_tree: string }).staged_tree).toMatch(/^[0-9a-f]{40}$/);

    const second = await commit(repo, ["a.txt"]);
    expect(second.status).toBe("ambiguous_staged");
    expect((second as { staged: string[] }).staged.sort()).toEqual(["a.txt", "generated.txt"]);
  });

  test("hook that drops an intended path from the index → commit_scope_mismatch", async () => {
    const repo = makeRepo("hook-drop");
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    writeFileSync(join(repo, "b.txt"), "bbb\n");
    setHook(repo, "git rm -q --cached b.txt\nexit 0\n");

    const r = await commit(repo, ["a.txt", "b.txt"]);

    expect(r.status).toBe("commit_scope_mismatch");
    const scope = r as { commit: string; intended: string[]; actual: string[] };
    expect(scope.intended).toEqual(["a.txt", "b.txt"]);
    expect(scope.actual).toEqual(["a.txt"]);
    // The reported commit is the real created commit.
    expect(scope.commit).toBe(sh(repo, "git", "rev-parse", "HEAD"));
    expect(commitFiles(repo)).toEqual(["a.txt"]);
  });

  // Acceptance coverage, NOT a red-before-fix regression proof: modern Git
  // stages a plain deletion with `git add <path>` too, so this test passes
  // with or without the defensive `-A` in checkpoint_commit.
  test("a deleted tracked path (deleted via rm) commits as a deletion", async () => {
    const repo = makeRepo("clean-deletion");
    writeFileSync(join(repo, "doomed.txt"), "bye\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "add doomed");
    rmSync(join(repo, "doomed.txt"));

    const r = await commit(repo, ["doomed.txt"]);

    expect(r.status).toBe("committed");
    expect(commitFiles(repo)).toEqual(["doomed.txt"]);
    expect(sh(repo, "git", "show", "--name-status", "--format=", "HEAD")).toBe("D\tdoomed.txt");
  });

  test("a pre-staged subset is allowed and the full intended set is committed", async () => {
    const repo = makeRepo("staged-subset");
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    writeFileSync(join(repo, "b.txt"), "bbb\n");
    sh(repo, "git", "add", "--", "a.txt");

    const r = await commit(repo, ["a.txt", "b.txt"]);

    expect(r.status).toBe("committed");
    expect(commitFiles(repo)).toEqual(["a.txt", "b.txt"]);
  });

  test("a pre-staged path outside the intended set still rejects as ambiguous", async () => {
    const repo = makeRepo("staged-outside");
    writeFileSync(join(repo, "a.txt"), "aaa\n");
    writeFileSync(join(repo, "other.txt"), "other\n");
    sh(repo, "git", "add", "--", "other.txt");

    const r = await commit(repo, ["a.txt"]);

    expect(r.status).toBe("ambiguous_staged");
    expect((r as { staged: string[] }).staged).toEqual(["other.txt"]);
  });

  test("a real merge commit keeps both parents and an exact first-parent scope", async () => {
    const repo = makeRepo("merge");
    sh(repo, "git", "checkout", "-qb", "side");
    writeFileSync(join(repo, "side.txt"), "side\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "side change");
    sh(repo, "git", "checkout", "-q", "main");
    // Diverge main so the merge produces a real two-parent commit.
    writeFileSync(join(repo, "main.txt"), "main\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "main change");
    // --no-commit leaves MERGE_HEAD set and the merged-in side.txt staged.
    sh(repo, "git", "merge", "--no-commit", "side");

    const r = await commit(repo, ["side.txt"], "merge checkpoint");

    expect(r.status).toBe("committed");
    expect(sh(repo, "git", "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(commitFiles(repo)).toEqual(["side.txt"]);
    expect(sh(repo, "git", "status", "--porcelain")).toBe("");
  });

  /** A repo left in a real merge state whose side branch brings TWO paths. */
  function makeTwoPathMerge(name: string): string {
    const repo = makeRepo(name);
    sh(repo, "git", "checkout", "-qb", "side");
    writeFileSync(join(repo, "side-a.txt"), "a\n");
    writeFileSync(join(repo, "side-b.txt"), "b\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "side change");
    sh(repo, "git", "checkout", "-q", "main");
    writeFileSync(join(repo, "main.txt"), "main\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "main change");
    sh(repo, "git", "merge", "--no-commit", "side");
    return repo;
  }

  test("merging two paths commits exactly when both are listed", async () => {
    const repo = makeTwoPathMerge("merge-two");

    const r = await commit(repo, ["side-a.txt", "side-b.txt"], "merge two paths");

    expect(r.status).toBe("committed");
    expect(sh(repo, "git", "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(commitFiles(repo)).toEqual(["side-a.txt", "side-b.txt"]);
    expect(sh(repo, "git", "status", "--porcelain")).toBe("");
  });

  test("listing only one path of a merge fails closed — the merge scope is the whole merge", async () => {
    const repo = makeTwoPathMerge("merge-partial");
    const headBefore = sh(repo, "git", "rev-parse", "HEAD");

    const r = await commit(repo, ["side-a.txt"], "partial merge");

    // The merge itself already staged BOTH merged paths, so a narrower path
    // list is caught by the pre-staged guard (an outside path in the index)
    // before any commit exists: the merge cannot be committed narrower than
    // the merge.
    expect(r.status).toBe("ambiguous_staged");
    const refused = r as { staged: string[]; intended: string[] };
    expect(refused.intended).toEqual(["side-a.txt"]);
    expect(refused.staged.sort()).toEqual(["side-a.txt", "side-b.txt"]);
    expect(sh(repo, "git", "rev-parse", "HEAD")).toBe(headBefore);
  });

  test("a merge commit narrowed by a hook is caught by the scope postcondition", async () => {
    const repo = makeTwoPathMerge("merge-narrowed");
    setHook(repo, "git rm -q --cached side-b.txt\nexit 0\n");

    const r = await commit(repo, ["side-a.txt", "side-b.txt"], "narrowed merge");

    expect(r.status).toBe("commit_scope_mismatch");
    const scope = r as { intended: string[]; actual: string[] };
    expect(scope.intended).toEqual(["side-a.txt", "side-b.txt"]);
    expect(scope.actual).toEqual(["side-a.txt"]);
  });

  test("deletions commit exactly, even under an extra-staging hook", async () => {
    const repo = makeRepo("deletion");
    writeFileSync(join(repo, "doomed.txt"), "bye\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-qm", "add doomed");
    setHook(repo, "echo generated > generated.txt\ngit add generated.txt\nexit 0\n");
    rmSync(join(repo, "doomed.txt"));

    const r = await commit(repo, ["doomed.txt"]);

    expect(r.status).toBe("commit_scope_mismatch");
    const scope = r as { intended: string[]; actual: string[] };
    expect(scope.intended).toEqual(["doomed.txt"]);
    expect(scope.actual).toEqual(["doomed.txt", "generated.txt"]);
  });
});
