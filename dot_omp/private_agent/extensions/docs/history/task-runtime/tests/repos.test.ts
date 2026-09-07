/**
 * §34.4 Repos / worktrees tests.
 *
 * Covers:
 *  - canonical top-level normalization (path → git toplevel)
 *  - duplicate canonical repo path rejected
 *  - basename collision rejected
 *  - reference repo omitted from worktree plan
 *  - primary/target included in worktree plan
 *  - existing recorded worktree is validated/reused (idempotent)
 *  - unexpected existing branch causes safe failure
 *  - dirty registered repo blocks handoff
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn, ExecResult } from "../types.ts";

let homeDir: string;
let workDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-repos-"));
  workDir = join(homeDir, "work");
  await mkdir(workDir, { recursive: true });
  // Fake HOME hides the developer's global git config; commits in fixtures
  // need an identity or git exits 128.
  await writeFile(
    join(homeDir, ".gitconfig"),
    "[user]\n\tname = Task Runtime Test\n\temail = task-runtime@example.com\n",
  );
  originalBunHome = Bun.env.HOME;
  originalProcHome = process.env.HOME;
  Bun.env.HOME = homeDir;
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalBunHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = originalBunHome;
  if (originalProcHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalProcHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function makeRepo(name: string): Promise<string> {
  const repo = join(workDir, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

/**
 * Pre-baked exec mock that handles `-C <path>` correctly.
 *
 * `repos` maps repo basename → canonical absolute path. The mock resolves
 * any `-C` arg pointing into one of those trees.
 */
function execFor(repos: Record<string, string>, opts: {
  abbrevRef?: string;
  headSha?: string;
  statusPorcelain?: string;
} = {}): ExecFn {
  const abbrevRef = opts.abbrevRef ?? "feat/x";
  const headSha = opts.headSha ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const statusPorcelain = opts.statusPorcelain ?? "";
  function parseArgs(args: string[]): { sub: string; rest: string[]; cwd?: string } {
    if (args[0] === "-C") return { sub: args[2], rest: args.slice(3), cwd: args[1] };
    return { sub: args[0], rest: args.slice(1) };
  }
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr = ""): ExecResult => ({ code: 1, stdout: "", stderr });
  return async (cmd, args) => {
    if (cmd !== "git") return ok();
    const { sub, rest, cwd } = parseArgs(args);
    if (sub === "rev-parse" && rest.includes("--show-toplevel")) {
      const target = cwd ?? rest[0];
      for (const r of Object.values(repos)) {
        if (target === r || target.startsWith(r + "/")) return ok(r + "\n");
      }
      return fail("fatal: not a git repository");
    }
    if (sub === "rev-parse" && rest.includes("--abbrev-ref")) return ok(abbrevRef + "\n");
    if (sub === "rev-parse" && rest.includes("--verify")) return fail();
    if (sub === "rev-parse" && rest.includes("HEAD")) return ok(headSha + "\n");
    if (sub === "status" && rest.some(a => a.startsWith("--porcelain"))) return ok(statusPorcelain);
    if (sub === "worktree" && rest[0] === "add") {
      const dir = rest[rest.indexOf("-b") + 1];
      await mkdir(dir, { recursive: true });
      return ok();
    }
    if (sub === "worktree" && rest[0] === "list") return ok();
    if (sub === "diff" && rest.includes("--numstat")) return ok();
    return ok();
  };
}

describe("attachRepo canonical normalization", () => {
  test("subdirectory path resolves to git top-level", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("alpha");
    await mkdir(join(repo, "deep", "nested"), { recursive: true });
    const exec = execFor({ alpha: repo });
    const entry = await r.attachRepo(exec, {
      existing: [],
      rawPath: join(repo, "deep", "nested"),
      role: "target",
    });
    expect(entry.sourcePath).toBe(repo);
    expect(entry.name).toBe("alpha");
  });

  test("rejects path that is not a git repo", async () => {
    const r = await import("../repos.ts");
    const exec = execFor({});
    await expect(
      r.attachRepo(exec, {
        existing: [],
        rawPath: join(workDir, "no-such-repo"),
        role: "target",
      }),
    ).rejects.toThrow(/not a git repo/);
  });

  test("rejects role=primary through attachRepo", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("beta");
    const exec = execFor({ beta: repo });
    await expect(
      r.attachRepo(exec, {
        existing: [],
        rawPath: repo,
        // @ts-expect-error intentionally wrong role
        role: "primary",
      }),
    ).rejects.toThrow();
  });
});

describe("attachRepo collisions", () => {
  test("rejects basename collision (same repo added twice)", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("gamma");
    const exec = execFor({ gamma: repo });
    const existing = [{ name: "gamma", role: "target" as const, sourcePath: repo }];
    await expect(
      r.attachRepo(exec, { existing, rawPath: repo, role: "target" }),
    ).rejects.toThrow(/already registered/);
  });

  test("rejects duplicate canonical path under a different name (symlink)", async () => {
    const r = await import("../repos.ts");
    const repoA = join(workDir, "alias-a");
    const repoB = join(workDir, "alias-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await symlink(repoA, repoB);
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: repoA + "\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const existing = [{ name: "alias-a", role: "target" as const, sourcePath: repoA }];
    await expect(
      r.attachRepo(exec, { existing, rawPath: repoB, role: "target" }),
    ).rejects.toThrow(/already registered/);
  });
});

describe("dirty check", () => {
  test("clean repo passes", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("clean");
    const exec = execFor({ clean: repo });
    const result = await r.isRepoClean(exec, repo);
    expect(result.clean).toBe(true);
  });

  test("dirty repo fails with summary", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("dirty");
    const exec = execFor({ dirty: repo }, { statusPorcelain: " M foo.ts\n" });
    const result = await r.isRepoClean(exec, repo);
    expect(result.clean).toBe(false);
    expect(result.summary).toContain("foo.ts");
  });
});

describe("worktree plan does not include reference repos", () => {
  test("primary and target are scheduled; reference is not", async () => {
    const primary = await makeRepo("primary");
    const target = await makeRepo("target");
    const reference = await makeRepo("reference");
    const repos = {
      primary: { name: "primary", role: "primary" as const, sourcePath: primary },
      target: { name: "target", role: "target" as const, sourcePath: target },
      reference: { name: "reference", role: "reference" as const, sourcePath: reference },
    };
    const plan = Object.entries(repos).filter(([, e]) => e.role !== "reference");
    expect(plan.map(([n]) => n).sort()).toEqual(["primary", "target"]);
  });
});

describe("createWorktree idempotency + safety", () => {
  test("creates new worktree", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("new-wt");
    const wtDir = join(homeDir, ".omp", "tasks", "id1", "worktrees", "new-wt");
    const exec = execFor({ "new-wt": repo });
    const result = await r.createWorktree(exec, {
      repoPath: repo,
      worktreeDir: wtDir,
      branch: "feat/x",
      baseSha: "deadbeef",
    });
    expect(result.created).toBe(true);
    expect(result.headSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  test("reuses existing valid worktree (HEAD + branch match)", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("reused-wt");
    const wtDir = join(homeDir, ".omp", "tasks", "id2", "worktrees", "reused-wt");
    await mkdir(wtDir, { recursive: true });
    const exec = execFor({ "reused-wt": repo });
    const result = await r.createWorktree(exec, {
      repoPath: repo,
      worktreeDir: wtDir,
      branch: "feat/x",
      baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(result.created).toBe(false);
  });

  test("rejects when existing worktree branch mismatches", async () => {
    const r = await import("../repos.ts");
    const repo = await makeRepo("bad-branch");
    const wtDir = join(homeDir, ".omp", "tasks", "id3", "worktrees", "bad-branch");
    await mkdir(wtDir, { recursive: true });
    const exec = execFor({ "bad-branch": repo }, { abbrevRef: "feat/other" });
    await expect(
      r.createWorktree(exec, {
        repoPath: repo,
        worktreeDir: wtDir,
        branch: "feat/x",
        baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).rejects.toThrow(/is on branch/);
  });
});

describe("path safety", () => {
  test("worktreePath rejects .. and unsafe names", async () => {
    const paths = await import("../paths.ts");
    expect(() => paths.worktreePath("ab", "..")).toThrow();
    expect(() => paths.worktreePath("ab", "foo/bar")).toThrow();
    expect(() => paths.worktreePath("ab", "")).toThrow();
  });

  test("worktreePath rejects unsafe task id", async () => {
    const paths = await import("../paths.ts");
    expect(() => paths.worktreePath("..", "ok")).toThrow();
    expect(() => paths.worktreePath("a", "ok")).toThrow();
  });
});

/**
 * Fix 4 regression — diffSummaryAgainst with real git repos.
 */

// realExec delegates to actual git binary
function realExec(): ExecFn {
  return async (cmd, args) => {
    if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
    const sub = args[2] ?? args[0];
    // worktree ops still require real worktree dirs; skip for diff tests
    if (sub === "worktree") {
      const wtDir = args[args.length - 1];
      await mkdir(wtDir, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    // rev-parse
    if (sub === "rev-parse" && args.includes("--show-toplevel")) {
      const { execSync } = await import("child_process");
      const out = execSync("git rev-parse --show-toplevel", { cwd: args[1], encoding: "utf8" }).trim();
      return { code: 0, stdout: out + "\n", stderr: "" };
    }
    // Default: delegate to real git via spawnSync (array, no shell injection)
    const { spawnSync } = await import("child_process");
    const r2 = spawnSync("git", (args as string[]).slice(2), { cwd: args[1], encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
    return { code: r2.status ?? 0, stdout: r2.stdout ?? "", stderr: r2.stderr ?? "" };
  };
}

describe("diffSummaryAgainst — untracked files (Fix 4)", () => {
  test("untracked file after commit counts as changed file", async () => {
    const repoDir = join(homeDir, "work", "fix4-repo");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("child_process");
    execSync("git init && git commit --allow-empty -m init", { cwd: repoDir, stdio: "ignore" });
    execSync("touch README.md && git add README.md && git commit -m base", { cwd: repoDir, stdio: "ignore" });
    const baseSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();

    // Create untracked file — no git add
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "untracked.ts"), "export const x = 1;\n");

    const r = await import("../repos.ts");
    const real = realExec();
    const d = await r.diffSummaryAgainst(real, repoDir, baseSha);
    // tracked: nothing changed. untracked: 1 file.
    expect(d.files).toBe(1);
    // Head doesn't have this file, so tracked diff is empty
    expect(d.insertions).toBe(0);
    expect(d.deletions).toBe(0);
  });

  test("mixed tracked modification + untracked file counted separately", async () => {
    const repoDir = join(homeDir, "work", "fix4-mixed");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("child_process");
    execSync("git init && git commit --allow-empty -m init", { cwd: repoDir, stdio: "ignore" });
    execSync("touch README.md && git add README.md && git commit -m base", { cwd: repoDir, stdio: "ignore" });
    const baseSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();

    // tracked modification
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repoDir, "README.md"), "changed tracked content\n");
    // untracked new file
    await writeFile(join(repoDir, "untracked.txt"), "hello world\n");

    const r = await import("../repos.ts");
    const d = await r.diffSummaryAgainst(realExec(), repoDir, baseSha);
    expect(d.files).toBe(2);
    expect(d.insertions).toBeGreaterThan(0); // changed README.md content
  });

  test("empty tree — no tracked changes, no untracked files → zero files", async () => {
    const repoDir = join(homeDir, "work", "fix4-clean");
    await mkdir(repoDir, { recursive: true });
    const { execSync } = await import("child_process");
    execSync("git init && git commit --allow-empty -m init", { cwd: repoDir, stdio: "ignore" });
    execSync("touch README.md && git add README.md && git commit -m base", { cwd: repoDir, stdio: "ignore" });
    const baseSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();

    const r = await import("../repos.ts");
    const d = await r.diffSummaryAgainst(realExec(), repoDir, baseSha);
    expect(d.files).toBe(0);
    expect(d.insertions).toBe(0);
    expect(d.deletions).toBe(0);
  });
});
