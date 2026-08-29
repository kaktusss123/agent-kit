/**
 * §36 E2E integration tests — lifecycle-level (no OMP runtime).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "../types.ts";
import { loadManifest } from "../storage.ts";

let homeDir: string;
let workDir: string;
let primaryRepo: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-e2e-"));
  workDir = join(homeDir, "work");
  primaryRepo = join(workDir, "primary");
  await mkdir(primaryRepo, { recursive: true });
  await mkdir(join(primaryRepo, ".git"), { recursive: true });
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

function fakeExec(numstat = ""): ExecFn {
  return async (cmd, args) => {
    if (cmd === "git") {
      const sub = args[2] ?? args[0];
      if (sub === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: primaryRepo + "\n", stderr: "" };
      if (sub === "rev-parse" && args.includes("HEAD")) return { code: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", stderr: "" };
      if (sub === "rev-parse" && args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
      if (sub === "status" && args.some(a => String(a).startsWith("--porcelain"))) return { code: 0, stdout: "", stderr: "" };
      if (sub === "diff" && args.includes("--numstat")) return { code: 0, stdout: numstat, stderr: "" };
      if (sub === "worktree" && args.includes("add")) { await mkdir(args[args.length - 2] , { recursive: true }); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "sh" && args[0] === "-c") {
      const c = args[1] as string;
      if (c.includes("echo pass")) return { code: 0, stdout: "pass\n", stderr: "" };
      if (c.includes("false")) return { code: 1, stdout: "", stderr: "fail" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

/**
 * Exec that fails "echo pass" on the first call, then passes.
 * Simulates implementer fixing a test between submits (same verification command).
 */
function failingThenPassingExec(numstat = ""): ExecFn {
  let callCount = 0;
  return async (cmd, args) => {
    if (cmd === "git") {
      const sub = args[2] ?? args[0];
      if (sub === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: primaryRepo + "\n", stderr: "" };
      if (sub === "rev-parse" && args.includes("HEAD")) return { code: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", stderr: "" };
      if (sub === "rev-parse" && args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
      if (sub === "status" && args.some(a => String(a).startsWith("--porcelain"))) return { code: 0, stdout: "", stderr: "" };
      if (sub === "diff" && args.includes("--numstat")) return { code: 0, stdout: numstat, stderr: "" };
      if (sub === "worktree" && args.includes("add")) { await mkdir(args[args.length - 2] , { recursive: true }); return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "sh" && args[0] === "-c") {
      const c = args[1] as string;
      if (c.includes("echo pass")) {
        callCount++;
        // First call: test fails (exit 1). Subsequent calls: test passes.
        if (callCount === 1) return { code: 1, stdout: "", stderr: "test failed: assert 1 == 2" };
        return { code: 0, stdout: "pass\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function setupImplementing(taskId: string, opts?: { verificationCmd?: string }): Promise<void> {
  const lc = await import("../lifecycle.ts");
  const exec = fakeExec();
  await lc.createTask({ id: taskId, type: "feat", primarySourcePath: primaryRepo, crackerSessionFile: "/c", exec });
  await lc.writeArtifact({ taskId, kind: "spec", content: "# Spec\nbody" });
  await lc.writeArtifact({ taskId, kind: "evidence", content: "## Evidence\nfact" });
  await lc.setVerification({ taskId, checks: [{ id: "t", repo: "primary", command: opts?.verificationCmd ?? "echo pass", required: true }] });
  const { readiness } = await lc.markReady(taskId);
  expect(readiness.ok).toBe(true);
  const { approval } = await lc.approveTask({ taskId, exec });
  await lc.prepareWorktrees({ taskId, exec });
  await lc.startImplementation({ taskId, approvalId: approval.id, implementerSessionFile: "/i", exec });
}

describe("E2E-1: basic one-repo lifecycle", () => {
  test("full flow → still_implementing (empty diff)", async () => {
    const lc = await import("../lifecycle.ts");
    const exec = fakeExec();
    const m = await lc.createTask({ id: "e1", type: "feat", primarySourcePath: primaryRepo, crackerSessionFile: "/c", exec });
    expect(m.phase).toBe("discovery");
    await lc.writeArtifact({ taskId: "e1", kind: "spec", content: "# Spec" });
    await lc.writeArtifact({ taskId: "e1", kind: "evidence", content: "## Evidence" });
    await lc.recordDecision({ taskId: "e1", action: "open", decisionId: "D1", question: "Q?", options: ["a", "b"] });
    expect((await (await import("../decisions.ts")).getOpenDecisions("e1")).length).toBe(1);
    await lc.recordDecision({ taskId: "e1", action: "resolve", decisionId: "D1", answer: "a" });
    expect((await (await import("../decisions.ts")).getOpenDecisions("e1")).length).toBe(0);
    await lc.setVerification({ taskId: "e1", checks: [{ id: "t", repo: "primary", command: "echo pass", required: true }] });
    const { readiness } = await lc.markReady("e1");
    expect(readiness.ok).toBe(true);
    expect((await loadManifest("e1")).phase).toBe("ready_for_approval");
    const { approval } = await lc.approveTask({ taskId: "e1", exec });
    expect((await loadManifest("e1")).phase).toBe("approved");
    expect(approval.specSha256).toMatch(/^[a-f0-9]{64}$/);
    const prep = await lc.prepareWorktrees({ taskId: "e1", exec });
    expect(prep.createdRepos).toContain("primary");
    await lc.startImplementation({ taskId: "e1", approvalId: approval.id, implementerSessionFile: "/impl", exec });
    expect((await loadManifest("e1")).phase).toBe("implementing");
    const out = await lc.submitImplementation({ taskId: "e1", exec });
    expect(out.kind).toBe("still_implementing");
  });
});

describe("E2E-2: unresolved decision blocks readiness", () => {
  test("markReady fails with open decisions", async () => {
    const lc = await import("../lifecycle.ts");
    const exec = fakeExec();
    await lc.createTask({ id: "e2", type: "fix", primarySourcePath: primaryRepo, crackerSessionFile: "/c", exec });
    await lc.writeArtifact({ taskId: "e2", kind: "spec", content: "s" });
    await lc.writeArtifact({ taskId: "e2", kind: "evidence", content: "e" });
    await lc.setVerification({ taskId: "e2", checks: [{ id: "t", repo: "primary", command: "true", required: true }] });
    await lc.recordDecision({ taskId: "e2", action: "open", decisionId: "D1", question: "Q?", options: ["a"] });
    const { readiness } = await lc.markReady("e2");
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.issues.some(i => i.code === "open_decisions")).toBe(true);
  });
});

describe("E2E-3: empty diff blocks completion", () => {
  test("submit returns still_implementing", async () => {
    await setupImplementing("e3");
    const out = await (await import("../lifecycle.ts")).submitImplementation({ taskId: "e3", exec: fakeExec() });
    expect(out.kind).toBe("still_implementing");
  });
});

describe("E2E-4: verification failure blocks completion", () => {
  test("submit returns still_implementing on failed check", async () => {
    await setupImplementing("e4", { verificationCmd: "false" });
    const out = await (await import("../lifecycle.ts")).submitImplementation({ taskId: "e4", exec: fakeExec() });
    expect(out.kind).toBe("still_implementing");
    if (out.kind === "still_implementing") expect(out.reason).toContain("t");
  });
});

describe("E2E-5: task_block → blocked → resume", () => {
  test("block and resume roundtrip", async () => {
    await setupImplementing("e5");
    const lc = await import("../lifecycle.ts");
    const blocked = await lc.blockTask({ taskId: "e5", reason: "SPEC_CONFLICT" });
    expect(blocked.phase).toBe("blocked");
    const resumed = await lc.resumeFromBlock("e5");
    expect(resumed.phase).toBe("implementing");
  });
});

describe("E2E-6: manual-only verification", () => {
  test("submit returns blocked_manual when no checks", async () => {
    const lc = await import("../lifecycle.ts");
    const exec = fakeExec();
    await lc.createTask({ id: "e6", type: "test", primarySourcePath: primaryRepo, crackerSessionFile: "/c", exec });
    await lc.writeArtifact({ taskId: "e6", kind: "spec", content: "s" });
    await lc.writeArtifact({ taskId: "e6", kind: "evidence", content: "e" });
    await lc.setVerification({ taskId: "e6", checks: [], manualReason: "External rendering" });
    const { readiness } = await lc.markReady("e6");
    expect(readiness.ok).toBe(true);
    const { approval } = await lc.approveTask({ taskId: "e6", exec });
    await lc.prepareWorktrees({ taskId: "e6", exec });
    await lc.startImplementation({ taskId: "e6", approvalId: approval.id, implementerSessionFile: "/i", exec });
    const out = await lc.submitImplementation({ taskId: "e6", exec });
    expect(out.kind).toBe("blocked_manual");
  });
});

describe("E2E-7: legacy manifest rejected", () => {
  test("v1 manifest triggers LegacyTaskError", async () => {
    const paths = await import("../paths.ts");
    const { writeFile } = await import("node:fs/promises");
    await mkdir(paths.taskRootDir("old"), { recursive: true });
    await writeFile(paths.manifestPath("old"), JSON.stringify({
      id: "old", type: "feat", phase: "analysis", primary: "p",
      repos: {}, specPath: "docs/specs/old.md",
      approvedSpecHash: null, snapshotHash: null, createdAt: "2026-01-01T00:00:00Z",
    }));
    await expect(loadManifest("old")).rejects.toThrow(/legacy/);
  });
});

describe("E2E-8: successful checks + non-empty diff → completed", () => {
  test("submit returns completed with numstat diff", async () => {
    await setupImplementing("e8");
    const lc = await import("../lifecycle.ts");
    const exec = fakeExec("10\t5\tsrc/foo.ts\n");
    const out = await lc.submitImplementation({ taskId: "e8", exec });
    expect(out.kind).toBe("completed");
    expect((await loadManifest("e8")).phase).toBe("completed");
  });
});

describe("E2E-9: fail → same-session fix → pass (retry path)", () => {
  test("verification check fails, then passes in same session (no cold restart)", async () => {
    await setupImplementing("e9");
    const lc = await import("../lifecycle.ts");

    // Exec: "echo pass" fails on first call (intentional failing test), passes on second (after fix).
    // Same verification command registered; no contract change during implementation.
    const exec = failingThenPassingExec("10\t5\tsrc/foo.ts\n");

    // First submit: check fails → still_implementing, task stays implementing
    const out1 = await lc.submitImplementation({ taskId: "e9", exec });
    expect(out1.kind).toBe("still_implementing");
    expect((await loadManifest("e9")).phase).toBe("implementing");
    if (out1.kind === "still_implementing") expect(out1.reason).toContain("t");

    // Second submit: same session, same contract, now passes → completed
    const out2 = await lc.submitImplementation({ taskId: "e9", exec });
    expect(out2.kind).toBe("completed");
    expect((await loadManifest("e9")).phase).toBe("completed");
  });
});

/**
 * §27 Fix 4 — untracked files count as implementation changes.
 */

describe("E2E-10: untracked file counts as implementation change", () => {
  test("submitImplementation does not return empty-diff with untracked file", async () => {
    const taskId = "e10";
    const lc = await import("../lifecycle.ts");
    const exec = fakeExec();
    await lc.createTask({ id: taskId, type: "feat", primarySourcePath: primaryRepo, crackerSessionFile: "/c10", exec });
    await lc.writeArtifact({ taskId, kind: "spec", content: "# Spec\nbody" });
    await lc.writeArtifact({ taskId, kind: "evidence", content: "## Evidence\nfact" });
    await lc.setVerification({ taskId, checks: [{ id: "t", repo: "primary", command: "echo pass", required: true }] });
    const { readiness } = await lc.markReady(taskId);
    expect(readiness.ok).toBe(true);
    const { approval } = await lc.approveTask({ taskId, exec });
    await lc.prepareWorktrees({ taskId, exec });
    await lc.startImplementation({ taskId, approvalId: approval.id, implementerSessionFile: "/i10", exec });

    // Simulate a new untracked file in the worktree by writing to disk and
    // providing a fakeExec that returns the diff stats plus status porcelain
    // with "?? untracked.ts".
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const wtDir = (await import("../paths.ts")).worktreePath(taskId, "primary");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(wtDir, { recursive: true });
    await writeFile(join(wtDir, "untracked.ts"), "export const x = 1;");

    // Provide an exec that shows untracked.ts via git status ONLY for the worktree,
    // NOT for the source repo (which must stay clean).
    const taggedExec: any = async (cmd, args, ...rest) => {
      const res = await exec(cmd, args, ...rest);
      // Intercept "git -C <worktreeDir> status --porcelain*" only
      if (
        cmd === "git" &&
        args.length >= 4 &&
        String(args[2]) === "status" &&
        args.some((a: any) => String(a).startsWith("--porcelain")) &&
        String(args[1]) === wtDir
      ) {
        return { code: 0, stdout: "?? untracked.ts\0", stderr: "" };
      }
      return res;
    };

    const out = await lc.submitImplementation({ taskId: "e10", exec: taggedExec });
    // Should NOT say empty-diff because untracked.ts counts
    expect(out.kind).not.toBe("still_implementing");
    // With a passing verification, should complete
    expect(out.kind).toBe("completed");
  });
});
