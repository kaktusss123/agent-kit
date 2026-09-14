/**
 * Behavioral tests for the bash mutation guard's command-position lexer
 * (parseGitInvocations) and the `cd <path> &&` idiom wiring in
 * guardManagedBashCommand. The incident that motivated the lexer: the words
 * `state` and `facts` inside a `gh pr create --title "… settled git state …
 * runtime git facts"` string were parsed as unknown git subcommands and the
 * whole command was blocked as "mutating git command on primary checkout".
 *
 * Fixture: like registration.test.ts, the fixture deliberately does NOT live
 * under /tmp — guardManagedBashCommand ignores temporary roots as scratch
 * space, so primary-checkout BLOCK verdicts are untestable there (unlike
 * core-isolation.test.ts, whose fixture never asserts guard blocks). The
 * fixture root is a scratch dir under $HOME, created per run and removed in
 * afterAll; everything else mirrors core-isolation: bare remote + source
 * repo + managed worktree via ensureTaskRepo. Session cwd = the primary
 * checkout, which is exactly the F3 incident shape.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import * as guardCore from "./guard";
import * as flowsCore from "./flows";

let fixtureRoot = "";
let taskRoot = "";
let sourceRepo = ""; // session cwd / primary checkout for every verdict
let managed = ""; // managed worktree path under taskRoot

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(homedir(), ".agent-kit-tw-guard-"));
  taskRoot = join(fixtureRoot, "tasks");
  sourceRepo = join(fixtureRoot, "source");
  await mkdir(taskRoot, { recursive: true });

  const remotePath = join(fixtureRoot, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remotePath]);
  execFileSync("git", ["init", "-q", "-b", "main", sourceRepo]);
  execFileSync("git", ["-C", sourceRepo, "config", "user.email", "guard@example.invalid"]);
  execFileSync("git", ["-C", sourceRepo, "config", "user.name", "Guard Fixture"]);
  execFileSync("git", ["-C", sourceRepo, "remote", "add", "origin", remotePath]);
  await writeFile(join(sourceRepo, "README.md"), "guard fixture\n");
  execFileSync("git", ["-C", sourceRepo, "add", "README.md"]);
  execFileSync("git", ["-C", sourceRepo, "commit", "-qm", "init"]);
  execFileSync("git", ["-C", sourceRepo, "branch", "feat/fixture"]);

  const result = await flowsCore.ensureTaskRepo(
    { branch: "feat/fixture", source_path: sourceRepo },
    sourceRepo,
    { taskRoot },
  );
  expect(result).toMatchObject({ status: "attached" });
  managed = (result as { worktree: string }).worktree;
  expect(managed.startsWith(taskRoot)).toBe(true);
});

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

/** Guard verdict with session cwd = the primary checkout (the F3 shape). */
function verdict(command: string) {
  return guardCore.guardManagedBashCommand(command, sourceRepo, { taskRoot });
}

describe("bash guard: command-position recognition", () => {
  test("allow: the F1 incident — prose containing the word git (gh pr create title)", () => {
    expect(
      verdict(
        `gh pr create --repo o/r --title "feat: verify settled git state on RepoOwner done; attach runtime git facts" --body-file /tmp/pr-body.md`,
      ),
    ).toBeUndefined();
  });

  test("allow: searching for guard strings (rg)", () => {
    expect(verdict(`rg -l "mutating git command" .`)).toBeUndefined();
  });

  test("allow: echo/printf arguments containing git", () => {
    expect(verdict(`echo git commit`)).toBeUndefined();
    expect(verdict(`printf '%s' git`)).toBeUndefined();
  });

  test("allow: --no-verify inside a comment is not a command", () => {
    expect(verdict(`echo hi # git commit --no-verify`)).toBeUndefined();
  });

  test("allow: cd <managed> && git commit (F3 idiom)", () => {
    expect(verdict(`cd ${managed} && git commit -m m`)).toBeUndefined();
  });

  test("allow: cd <managed> && git add -A && git commit -m m", () => {
    expect(verdict(`cd ${managed} && git add -A && git commit -m m`)).toBeUndefined();
  });

  test("allow: git -C <managed> commit", () => {
    expect(verdict(`git -C ${managed} commit -m m`)).toBeUndefined();
  });

  test("allow: full incident shape under the cd idiom", () => {
    expect(
      verdict(
        `cd ${managed} && gh pr create --repo o/r --title "feat: verify settled git state on RepoOwner done; attach runtime git facts" --body b`,
      ),
    ).toBeUndefined();
  });

  test("block: quoted git command word (F2 bypass)", () => {
    expect(verdict(`"git" commit -m m`)?.block).toBe(true);
  });

  test("block: plain primary-checkout commit", () => {
    expect(verdict(`git commit -m m`)?.block).toBe(true);
  });

  test("block: cd into the primary checkout", () => {
    expect(verdict(`cd ${sourceRepo} && git commit -m m`)?.block).toBe(true);
  });

  test("block: second cd in the remainder fails closed", () => {
    expect(
      verdict(`cd ${managed} && cd ${sourceRepo} && git commit -m m`)?.block,
    ).toBe(true);
  });

  test("block: || instead of && fails closed", () => {
    expect(verdict(`cd ${managed} || git commit -m m`)?.block).toBe(true);
  });

  test("block: command substitution recursion + --no-verify", () => {
    expect(verdict(`echo "$(git commit --no-verify -m x)"`)?.block).toBe(true);
  });

  test("block: raw --no-verify", () => {
    expect(verdict(`git commit --no-verify -m m`)?.block).toBe(true);
  });

  test("block: assignment prefix stays detected", () => {
    expect(verdict(`GIT_AUTHOR_NAME=x git commit -m m`)?.block).toBe(true);
  });
});

describe("parseGitInvocations lexer", () => {
  test("fully quoted command word is an invocation", () => {
    const invs = guardCore.parseGitInvocations(`'git' status`);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.subcommand).toBe("status");
  });

  test("backtick substitution contents are scanned", () => {
    const invs = guardCore.parseGitInvocations("echo `git push origin`");
    expect(invs).toHaveLength(1);
    expect(invs[0]!.operationClass).toBe("external-side-effect");
  });

  test("command substitution recursion finds exactly one mutating invocation", () => {
    const invs = guardCore.parseGitInvocations(`echo "$(git commit -m x)"`);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.mutating).toBe(true);
  });

  test("git in argument position is not an invocation", () => {
    expect(guardCore.parseGitInvocations(`echo git commit`)).toHaveLength(0);
  });

  test("-C repo ref is preserved", () => {
    const invs = guardCore.parseGitInvocations("git -C /tmp/r status");
    expect(invs[0]!.repoRef).toBe("/tmp/r");
  });

  test("line continuation cannot hide the subcommand", () => {
    // "git \<newline> commit" is "git commit" for the shell; the empty
    // continuation word must not become an empty subcommand token.
    const invs = guardCore.parseGitInvocations("git \\\n commit -m m");
    expect(invs).toHaveLength(1);
    expect(invs[0]!.subcommand).toBe("commit");
  });

  test("heredoc bodies remain parsed as commands — fail closed by design", () => {
    // Heredoc bodies are intentionally NOT modeled as inert data (the lexer
    // has no heredoc state), so the body stays scanned as a command list.
    // That over-detects (fail closed) exactly like the old regex did — the
    // guard must never miss a real invocation hiding below a heredoc opener.
    const invs = guardCore.parseGitInvocations("cat <<EOF\ngit commit -m x\nEOF");
    expect(invs).toHaveLength(1);
    expect(invs[0]!.mutating).toBe(true);
  });
});
