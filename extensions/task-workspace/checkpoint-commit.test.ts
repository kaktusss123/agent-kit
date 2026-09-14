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
  return sh(repo, "git", "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD")
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
    setHook(repo, "sed -i 's/unformatted/formatted/' a.txt\ngit add a.txt\nexit 0\n");

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
