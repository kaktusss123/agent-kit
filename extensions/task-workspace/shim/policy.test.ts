/**
 * Pure policy tests: real argv + real cwd → allow/block verdict. The
 * classification tables themselves are exercised through decidePolicy so
 * the corpus proves end-to-end verdicts, not just token classes. Fixture:
 * $HOME/.cache (the policy always passes temporary roots, so primary-
 * checkout BLOCK verdicts are untestable under /tmp).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "../../../tests/support/expect.ts";
import { createGuardFixture, type GuardFixture } from "./fixture.ts";
import * as policy from "./policy.mjs";
import { splitGitGlobalArgs } from "./classify.mjs";

let fx: GuardFixture;

beforeAll(async () => {
  fx = await createGuardFixture("agent-kit-policy-");
  // Fixture builds two managed worktrees plus ~25 git spawns; on a loaded
  // machine that exceeds the default hook timeout, so bound it explicitly.
});

afterAll(async () => {
  if (fx) await fx.destroy();
});

/** Policy verdict with the fixture's task root and a clean env. */
function decide(cwd: string, argv: string[], env: Record<string, string> = {}) {
  return policy.decidePolicy({ cwd, argv, env: { ...env }, taskRoot: fx.taskRoot });
}

function blockReason(cwd: string, argv: string[], env: Record<string, string> = {}) {
  const verdict = decide(cwd, argv, env);
  expect(verdict.verdict).toBe("BLOCK");
  return (verdict as { reason: string }).reason;
}

describe("policy: verdict corpus on the primary checkout (managed worktrees exist)", () => {
  test("local mutations block", () => {
    for (const argv of [
      ["commit", "-m", "x"],
      ["add", "-A"],
      ["branch", "-D", "tmp"],
      ["branch", "newname"],
      ["tag", "-f", "v1"],
      ["rebase"],
      ["reset", "--hard"],
      ["worktree", "add", "elsewhere"],
      ["update-ref", "refs/heads/x", "HEAD"],
      ["remote", "add", "origin", "https://example.invalid/r.git"],
    ]) {
      const verdict = decide(fx.primary, argv);
      expect(verdict.verdict, argv.join(" ")).toBe("BLOCK");
    }
  });

  test("read-only commands pass", () => {
    for (const argv of [
      ["status"],
      ["log", "--oneline"],
      ["diff"],
      ["rev-parse", "HEAD"],
      ["branch", "-l"],
      ["branch", "-v"],
      ["tag", "-l"],
      ["worktree", "list"],
      ["remote", "-v"],
      ["fetch", "origin"], // safe-refresh
    ]) {
      const verdict = decide(fx.primary, argv);
      expect(verdict.verdict, argv.join(" ")).toBe("ALLOW");
    }
  });

  test("inspection subcommands without a mutating mode pass", () => {
    for (const argv of [
      ["check-ignore", "-v", "node_modules"],
      ["check-attr", "-a", "README.md"],
      ["merge-base", "HEAD", "main"],
      ["merge-base", "--fork-point", "main"],
      ["rev-list", "--count", "HEAD"],
      ["blame", "README.md"],
      ["shortlog", "-sn", "HEAD"],
      ["name-rev", "HEAD"],
    ]) {
      const verdict = decide(fx.primary, argv);
      expect(verdict.verdict, argv.join(" ")).toBe("ALLOW");
    }
  });

  test("grep stays ambiguous → fail closed (-O runs an arbitrary pager command)", () => {
    expect(decide(fx.primary, ["grep", "-n", "TODO"]).verdict).toBe("BLOCK");
    expect(decide(fx.primary, ["grep", "-Ovim", "TODO"]).verdict).toBe("BLOCK");
  });

  test("push is an external side effect: allowed", () => {
    expect(decide(fx.primary, ["push", "origin", "main"]).verdict).toBe("ALLOW");
    expect(decide(fx.primary, ["push", "--force", "origin", "main"]).verdict).toBe(
      "ALLOW",
    );
  });

  test("unknown subcommand is ambiguous → mutating (fail closed)", () => {
    expect(decide(fx.primary, ["frobnicate"]).verdict).toBe("BLOCK");
    expect(decide(fx.primary, []).verdict).toBe("BLOCK");
    expect(decide(fx.primary, ["-C"]).verdict).toBe("BLOCK"); // dangling -C
  });

  test("fetch with a refs/heads destination is a local ref mutation; other destinations stay ambiguous → fail closed", () => {
    expect(
      decide(fx.primary, ["fetch", "origin", "+main:refs/heads/main"]).verdict,
    ).toBe("BLOCK");
    // Migrated classifier rule: a non-refs/heads destination is ambiguous,
    // and ambiguous fails closed.
    expect(decide(fx.primary, ["fetch", "origin", "+main:refs/tags/v1"]).verdict).toBe(
      "BLOCK",
    );
  });
});

describe("policy: --no-verify is blocked EVERYWHERE, before routing", () => {
  test("on the primary checkout", () => {
    expect(blockReason(fx.primary, ["commit", "--no-verify", "-m", "x"])).toContain(
      "checkpoint_commit",
    );
  });

  test("inside the managed worktree", () => {
    expect(blockReason(fx.managed, ["commit", "--no-verify", "-m", "x"])).toContain(
      "deferred_hook",
    );
  });

  test("outside any repository", () => {
    expect(blockReason(fx.root, ["commit", "--no-verify", "-m", "x"])).toContain(
      "Blocked: raw",
    );
  });

  test("commit -n short form", () => {
    expect(blockReason(fx.managed, ["commit", "-n", "-m", "x"])).toContain(
      "checkpoint_commit",
    );
  });
});

describe("policy: repository redirection fails closed for mutations", () => {
  test("--git-dir argv flag blocks a mutation", () => {
    expect(
      blockReason(fx.primary, ["--git-dir", join(fx.primary, ".git"), "commit", "-m", "x"]),
    ).toContain("--git-dir");
  });

  test("--work-tree=value inline form blocks a mutation", () => {
    expect(
      blockReason(fx.primary, [`--work-tree=${fx.primary}`, "add", "-A"]),
    ).toContain("git -C");
  });

  test("GIT_DIR environment blocks a mutation, read-only passes", () => {
    const env = { GIT_DIR: join(fx.primary, ".git") };
    expect(blockReason(fx.managed, ["commit", "-m", "x"], env)).toContain("GIT_DIR");
    expect(decide(fx.primary, ["status"], env).verdict).toBe("ALLOW");
  });

  test("GIT_WORK_TREE environment blocks a mutation", () => {
    expect(
      blockReason(fx.primary, ["reset", "--hard"], {
        GIT_WORK_TREE: fx.primary,
      }),
    ).toContain("GIT_WORK_TREE");
  });
});

describe("policy: -C chains resolve left-to-right (git semantics)", () => {
  test("relative -C resolves against the PREVIOUS -C result, not the session cwd", () => {
    // git -C <primary> -C sub commit → <primary>/sub → repo root = primary.
    // Naive "last -C against session cwd" would resolve <root>/sub (no
    // repo) and wrongly allow.
    mkdir(join(fx.primary, "sub"), { recursive: true });
    const reason = blockReason(fx.root, ["-C", fx.primary, "-C", "sub", "commit"]);
    expect(reason).toContain("primary checkout");
  });

  test("-C chain across nested repos resolves to the inner repo — block names it", () => {
    // child is its own repository and HAS a managed worktree: resolving the
    // chain left-to-right must land there (parent has none of its own). A
    // wrong resolution (parent, or the session cwd) would allow instead.
    const reason = blockReason(fx.root, ["-C", fx.parent, "-C", "child", "commit", "-m", "x"]);
    expect(reason).toContain(`primary checkout ${fx.child}`);
    expect(reason).toContain(fx.childManaged);
    expect(decide(fx.root, ["-C", fx.parent, "-C", "child", "status"]).verdict).toBe(
      "ALLOW",
    );
  });

  test("absolute -C replaces the previous result", () => {
    expect(
      decide(fx.parent, ["-C", fx.primary, "-C", "sub", "status"]).verdict,
    ).toBe("ALLOW");
    expect(decide(fx.parent, ["-C", fx.primary, "commit", "-m", "x"]).verdict).toBe(
      "BLOCK",
    );
  });
});

describe("policy: routing", () => {
  test("managed worktree mutation → allow", () => {
    expect(decide(fx.managed, ["commit", "-m", "x"]).verdict).toBe("ALLOW");
    expect(decide(fx.managed, ["add", "-A"]).verdict).toBe("ALLOW");
  });

  test("primary checkout with managed worktrees → block, naming root and hint", () => {
    const reason = blockReason(fx.primary, ["commit", "-m", "x"]);
    expect(reason).toContain(`primary checkout ${fx.primary}`);
    expect(reason).toContain(fx.managed);
    expect(reason).toContain("routing failure, not a bypass authorization");
  });

  test("primary checkout without managed worktrees → allow", () => {
    expect(decide(fx.parent, ["commit", "-m", "x"]).verdict).toBe("ALLOW");
  });

  test("linked worktree outside the task root → allow", () => {
    expect(decide(fx.otherWorktree, ["commit", "-m", "x"]).verdict).toBe("ALLOW");
  });

  test("temporary roots → allow", () => {
    expect(decide("/tmp/scratch-repo", ["commit", "-m", "x"]).verdict).toBe("ALLOW");
    expect(decide("/private/tmp/scratch", ["reset", "--hard"]).verdict).toBe("ALLOW");
  });

  test("outside any git repository → allow", () => {
    expect(decide(fx.root, ["commit", "-m", "x"]).verdict).toBe("ALLOW");
  });

  test("URI-like -C target is never a filesystem repo → allow", () => {
    expect(
      decide(fx.primary, ["-C", "local://nothing", "commit", "-m", "x"]).verdict,
    ).toBe("ALLOW");
  });
});

describe("policy: robustness", () => {
  test("never throws on hostile input", () => {
    expect(() =>
      policy.decidePolicy({ cwd: "/", argv: ["--weird", "-x", "commit"], env: {}, taskRoot: "" }),
    ).not.toThrow();
    expect(() =>
      policy.decidePolicy({ cwd: "", argv: [], env: { GIT_DIR: "x" }, taskRoot: fx.taskRoot }),
    ).not.toThrow();
  });

  test("empty task root fails mutations closed", () => {
    const verdict = policy.decidePolicy({
      cwd: fx.primary,
      argv: ["commit", "-m", "x"],
      env: {},
      taskRoot: "",
    });
    expect(verdict.verdict).toBe("BLOCK");
    expect((verdict as { reason: string }).reason).toContain("task root");
  });
});

describe("shared classifier: global-flag splitting", () => {
  test("collects the full -C chain in order", () => {
    expect(
      splitGitGlobalArgs(["-C", "/repo", "-C", "sub", "-c", "a=b", "commit"]),
    ).toEqual({
      chain: ["/repo", "sub"],
      hasGitDir: false,
      hasWorkTree: false,
      rest: ["commit"],
    });
  });

  test("detects --git-dir/--work-tree in both value forms", () => {
    expect(splitGitGlobalArgs(["--git-dir", "x", "status"]).hasGitDir).toBe(true);
    expect(splitGitGlobalArgs(["--work-tree=y", "status"]).hasWorkTree).toBe(true);
    expect(splitGitGlobalArgs(["status"]).hasGitDir).toBe(false);
  });
});
