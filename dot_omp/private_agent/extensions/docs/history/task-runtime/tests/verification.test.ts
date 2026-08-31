/**
 * §34.7 Verification tests.
 *
 * Covers:
 *  - parseContract: required check pass/fail
 *  - parseContract: duplicate ids rejected
 *  - parseContract: empty checks without manualReason rejected
 *  - parseContract: unknown check shape rejected
 *  - runContract: required check pass → success
 *  - runContract: required check fail → failure in outcomes
 *  - runContract: optional check fail does NOT block
 *  - runContract: command runs in the right worktree (cwd)
 *  - validateContractAgainstRepos: reference repo rejected
 *  - validateContractAgainstRepos: missing worktree rejected
 *  - manualOnly: contract with only manualReason is recognized
 *  - runContract on manualOnly returns manualOnly: true with empty outcomes
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn, TaskManifestV2 } from "../types.ts";

let homeDir: string;
let workDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-verify-"));
  workDir = join(homeDir, "work");
  await mkdir(workDir, { recursive: true });
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

async function writeContract(taskId: string, json: unknown): Promise<void> {
  const paths = await import("../paths.ts");
  await mkdir(paths.artifactsDir(taskId), { recursive: true });
  await writeFile(paths.verificationPath(taskId), JSON.stringify(json));
}

function mkManifest(repos: Record<string, { role: "primary" | "target" | "reference"; sourcePath: string; worktreePath?: string }>): TaskManifestV2 {
  const reposTyped: TaskManifestV2["repos"] = {};
  for (const [n, r] of Object.entries(repos)) {
    reposTyped[n] = {
      name: n,
      role: r.role,
      sourcePath: r.sourcePath,
      ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}),
    };
  }
  return {
    schemaVersion: 2,
    id: "t",
    type: "feat",
    phase: "implementing",
    primaryRepo: Object.entries(repos).find(([, r]) => r.role === "primary")?.[0] ?? "primary",
    repos: reposTyped,
    sessions: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("parseContract", () => {
  test("accepts a single required check", async () => {
    const v = await import("../verification.ts");
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "r", command: "go test", required: true }],
    }));
    expect(c.checks.length).toBe(1);
    expect(c.checks[0].required).toBe(true);
  });

  test("accepts checks with manualReason only", async () => {
    const v = await import("../verification.ts");
    const c = v.parseContract(JSON.stringify({ checks: [], manualReason: "no harness" }));
    expect(c.checks.length).toBe(0);
    expect(c.manualReason).toBe("no harness");
  });

  test("rejects empty checks with no manualReason", async () => {
    const v = await import("../verification.ts");
    expect(() => v.parseContract(JSON.stringify({ checks: [] }))).toThrow();
  });

  test("rejects empty manualReason", async () => {
    const v = await import("../verification.ts");
    expect(() => v.parseContract(JSON.stringify({ checks: [], manualReason: "   " }))).toThrow();
  });

  test("rejects duplicate ids", async () => {
    const v = await import("../verification.ts");
    expect(() =>
      v.parseContract(JSON.stringify({
        checks: [
          { id: "t", repo: "r", command: "a", required: true },
          { id: "t", repo: "r", command: "b", required: false },
        ],
      })),
    ).toThrow(/duplicate/);
  });

  test("rejects non-boolean required", async () => {
    const v = await import("../verification.ts");
    expect(() =>
      v.parseContract(JSON.stringify({
        checks: [{ id: "t", repo: "r", command: "a", required: "yes" }],
      })),
    ).toThrow(/required must be boolean/);
  });

  test("rejects malformed JSON", async () => {
    const v = await import("../verification.ts");
    expect(() => v.parseContract("{ not json")).toThrow(/not valid JSON/);
  });
});

describe("validateContractAgainstRepos", () => {
  test("rejects reference repo reference", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("ref-only");
    const m = mkManifest({ refonly: { role: "reference", sourcePath: repo } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "refonly", command: "true", required: true }],
    }));
    const r = v.validateContractAgainstRepos(c, m);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("reference");
  });

  test("rejects unknown repo", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("p");
    const m = mkManifest({ p: { role: "primary", sourcePath: repo, worktreePath: "/tmp/wt" } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "ghost", command: "true", required: true }],
    }));
    const r = v.validateContractAgainstRepos(c, m);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ghost");
  });

  test("rejects missing worktreePath", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("p2");
    const m = mkManifest({ p: { role: "primary", sourcePath: repo } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "p", command: "true", required: true }],
    }));
    const r = v.validateContractAgainstRepos(c, m, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("worktree");
  });

  test("accepts primary + target worktrees", async () => {
    const v = await import("../verification.ts");
    const p = await makeRepo("p");
    const t = await makeRepo("t");
    const m = mkManifest({
      p: { role: "primary", sourcePath: p, worktreePath: "/tmp/wp" },
      t: { role: "target", sourcePath: t, worktreePath: "/tmp/wt" },
    });
    const c = v.parseContract(JSON.stringify({
      checks: [
        { id: "p-test", repo: "p", command: "true", required: true },
        { id: "t-test", repo: "t", command: "true", required: true },
      ],
    }));
    expect(v.validateContractAgainstRepos(c, m).ok).toBe(true);
  });
});

describe("runContract", () => {
  function shExec(outcomes: Record<string, number>): ExecFn {
    // outcomes maps the COMMAND STRING to exit code.
    return async (cmd, args) => {
      if (cmd !== "sh") return { code: 0, stdout: "", stderr: "" };
      const command = args[args.length - 1];
      const code = outcomes[command] ?? 0;
      return { code, stdout: code === 0 ? "ok" : `failed: ${command}`, stderr: "" };
    };
  }

  test("required check pass → no required failures", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("rp");
    const wt = join(homeDir, ".omp", "tasks", "vt", "worktrees", "rp");
    await mkdir(wt, { recursive: true });
    const m = mkManifest({ rp: { role: "primary", sourcePath: repo, worktreePath: wt } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "rp", command: "echo pass", required: true }],
    }));
    const r = await v.runContract(shExec({ "echo pass": 0 }), c, m);
    expect(r.requiredFailures).toEqual([]);
    expect(r.outcomes[0].status).toBe("pass");
  });

  test("required check fail → required failure recorded", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("rf");
    const wt = join(homeDir, ".omp", "tasks", "vt2", "worktrees", "rf");
    await mkdir(wt, { recursive: true });
    const m = mkManifest({ rf: { role: "primary", sourcePath: repo, worktreePath: wt } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "rf", command: "false", required: true }],
    }));
    const r = await v.runContract(shExec({ "false": 1 }), c, m);
    expect(r.requiredFailures).toEqual(["t"]);
    expect(r.outcomes[0].status).toBe("fail");
  });

  test("optional check fail does NOT add to requiredFailures", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("ro");
    const wt = join(homeDir, ".omp", "tasks", "vt3", "worktrees", "ro");
    await mkdir(wt, { recursive: true });
    const m = mkManifest({ ro: { role: "primary", sourcePath: repo, worktreePath: wt } });
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "lint", repo: "ro", command: "lint", required: false }],
    }));
    const r = await v.runContract(shExec({ "lint": 2 }), c, m);
    expect(r.requiredFailures).toEqual([]);
    expect(r.optionalFailures).toEqual(["lint"]);
    expect(r.outcomes[0].status).toBe("fail");
  });

  test("command runs in the registered repo's worktree", async () => {
    const v = await import("../verification.ts");
    const repo = await makeRepo("cwd");
    const wt = join(homeDir, ".omp", "tasks", "vt4", "worktrees", "cwd");
    await mkdir(wt, { recursive: true });
    const m = mkManifest({ cwd: { role: "primary", sourcePath: repo, worktreePath: wt } });
    let capturedCwd = "";
    const exec: ExecFn = async (cmd, args, options) => {
      if (cmd !== "sh") return { code: 0, stdout: "", stderr: "" };
      capturedCwd = options?.cwd ?? "";
      return { code: 0, stdout: "", stderr: "" };
    };
    const c = v.parseContract(JSON.stringify({
      checks: [{ id: "t", repo: "cwd", command: "pwd", required: true }],
    }));
    await v.runContract(exec, c, m);
    expect(capturedCwd).toBe(wt);
  });

  test("manualOnly contract: empty outcomes, manualOnly=true", async () => {
    const v = await import("../verification.ts");
    const m = mkManifest({});
    const c = v.parseContract(JSON.stringify({ checks: [], manualReason: "external only" }));
    const r = await v.runContract(async () => ({ code: 0, stdout: "", stderr: "" }), c, m);
    expect(r.manualOnly).toBe(true);
    expect(r.outcomes).toEqual([]);
  });
});
