import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execSync } from "child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, saveManifest } from "../storage.ts";
import { createTask } from "../lifecycle.ts";
import { registerWritePolicy, protectedRepos } from "../permissions.ts";
import type { ExecFn } from "../types.ts";

let homeDir: string;
let workDir: string;
let primaryRepo: string;
let primaryWorktree: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;
const TASK_ID = "policy-v2";

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-policy-"));
  workDir = join(homeDir, "work");
  primaryRepo = join(workDir, "primary-repo");
  primaryWorktree = join(homeDir, ".omp", "tasks", TASK_ID, "worktrees", "primary-repo");
  await mkdir(primaryRepo, { recursive: true });
  await mkdir(join(primaryRepo, ".git"), { recursive: true });
  execSync("git init && git commit --allow-empty -m init", { cwd: primaryRepo, stdio: "ignore" });
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

function fakeExec(): ExecFn {
  return async () => ({ code: 0, stdout: "", stderr: "" });
}

const fakeExecSync: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });

function realExec(): ExecFn {
  return async (cmd, args) => {
    if (cmd === "git") {
      const cwd = args[1];
      const sub = args.slice(2);
      try {
        const out = execSync("git " + sub.join(" "), { cwd, encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
        return { code: 0, stdout: out, stderr: "" };
      } catch(e: any) { return { code: 1, stdout: "", stderr: e.stderr ?? "" }; }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

interface FakePi {
  toolCallHandlers: Array<(e: { toolName: string; toolCallId: string; input: unknown }, ctx: unknown) => Promise<unknown>>;
  toolResultHandlers: Array<(e: { toolName: string; toolCallId: string; content: unknown; isError: boolean }, ctx: unknown) => Promise<unknown>>;
}

function fakePi(exec?: ExecFn): FakePi {
  const pi: any = { toolCallHandlers: [], toolResultHandlers: [] };
  pi.on = (e: string, h: any) => { if (e==="tool_call") pi.toolCallHandlers.push(h); if (e==="tool_result") pi.toolResultHandlers.push(h); };
  if (exec) pi.exec = exec;
  return pi;
}

function fakeCtx(opts: { sessionFile: string | undefined; cwd: string }): unknown {
  return { cwd: opts.cwd, sessionManager: { getSessionFile: () => opts.sessionFile }, ui: {} };
}

async function seedManifestWithRoles(opts: { crackerSessionFile: string; implementerSessionFile: string; }): Promise<void> {
  await createTask({ id: TASK_ID, type: "feat", primarySourcePath: primaryRepo, crackerSessionFile: opts.crackerSessionFile, exec: realExec() });
  await mkdir(primaryWorktree, { recursive: true });
  const m = await loadManifest(TASK_ID);
  m.repos[m.primaryRepo].worktreePath = primaryWorktree;
  m.sessions.implementer = { sessionFile: opts.implementerSessionFile, role: "implementer", createdAt: new Date().toISOString() };
  await saveManifest(m);
}

describe.serial("registerWritePolicy — pre-tool guard", () => {
  test("cracker session write to primary source → blocked", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c1", implementerSessionFile: "/i1" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    let editH = pi.toolCallHandlers[0];
    expect(editH).toBeDefined();
    const r = await editH!(
      { toolName: "write", toolCallId: "t1", input: { path: join(primaryRepo, "evil.ts"), content: "x" } },
      fakeCtx({ sessionFile: "/c1", cwd: primaryRepo }),
    );
    expect((r as any).block).toBe(true);
  });

  test("implementer session write to worktree → allowed", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c2", implementerSessionFile: "/i2" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const r = await (pi.toolCallHandlers[0])(
      { toolName: "write", toolCallId: "t2", input: { path: join(primaryWorktree, "new.ts"), content: "x" } },
      fakeCtx({ sessionFile: "/i2", cwd: primaryWorktree }),
    );
    expect(r === undefined || !(r as any).block).toBe(true);
  });

  test("implementer session write to original source → blocked", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c3", implementerSessionFile: "/i3" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const r = await (pi.toolCallHandlers[0])(
      { toolName: "edit", toolCallId: "t3", input: { path: join(primaryRepo, "config.ts"), newText: "x" } },
      fakeCtx({ sessionFile: "/i3", cwd: primaryWorktree }),
    );
    expect((r as any).block).toBe(true);
  });

  test("unbound session → write silently allowed (no manifest)", async () => {
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const r = await (pi.toolCallHandlers[0])(
      { toolName: "write", toolCallId: "tu", input: { path: "/tmp/x", content: "x" } },
      fakeCtx({ sessionFile: undefined, cwd: "/tmp" }),
    );
    expect(r).toBeUndefined();
  });
});

describe.serial("registerWritePolicy — bash tool_result guard", () => {
  test("bash handler populates and drains pending fingerprints without error", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c4", implementerSessionFile: "/i4" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    // Handler 1 is the bash fingerprint capture
    expect(pi.toolCallHandlers.length).toBeGreaterThanOrEqual(2);
    const bashH = pi.toolCallHandlers[1];
    await bashH!(
      { toolName: "bash", toolCallId: "bgn", input: { command: "echo hi" } },
      fakeCtx({ sessionFile: "/i4", cwd: primaryWorktree }),
    );
    // No mutation → tool_result handler returns undefined (pass-through)
    const r = await pi.toolResultHandlers[0](
      { toolName: "bash", toolCallId: "bgn", content: [{ type: "text", text: "ok" }], isError: false },
      fakeCtx({ sessionFile: "/i4", cwd: primaryWorktree }),
    );
    expect(r).toBeUndefined();
  });
});

describe.serial("registerWritePolicy — bash rollback on mutation", () => {
  test("detects HEAD mutation in protected repo and returns POLICY_VIOLATION", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c5", implementerSessionFile: "/i5" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);

    // Verify protectedRepos sees the real repo
    const m = await loadManifest(TASK_ID);
    const prot = protectedRepos({ role: "implementer", manifest: m });
    expect(prot.length).toBeGreaterThan(0);
    expect(prot[0].canonical).toBe(realpathSync(primaryRepo));

    const headBefore = execSync("git rev-parse HEAD", { cwd: primaryRepo, encoding: "utf8" }).trim();

    const bashH = pi.toolCallHandlers[1];
    const ctx = fakeCtx({ sessionFile: "/i5", cwd: primaryWorktree });
    await bashH!({ toolName: "bash", toolCallId: "br-mut", input: { command: "echo" } }, ctx);

    execSync("git commit --allow-empty -m mutation", { cwd: primaryRepo, stdio: "ignore" });
    const headAfter = execSync("git rev-parse HEAD", { cwd: primaryRepo, encoding: "utf8" }).trim();
    expect(headAfter).not.toBe(headBefore);

    const result = await pi.toolResultHandlers[0](
      { toolName: "bash", toolCallId: "br-mut", content: [{ type: "text", text: "ok" }], isError: false },
      ctx,
    );
    expect(result).toBeDefined();
    const res = result as { isError?: boolean; content?: { type: string; text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? "").toMatch(/POLICY_VIOLATION/);
  });
});

describe.serial("registerWritePolicy — bash rollback on dirty repo", () => {
  test("pre-existing dirty state prevents destructive reset — returns POLICY_VIOLATION_UNSAFE", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c6", implementerSessionFile: "/i6" });

    // Create pre-existing tracked change BEFORE bash
    execSync("touch dirty-tracked.txt && git add dirty-tracked.txt && git commit -m pre", { cwd: primaryRepo, stdio: "ignore" });
    const trackedFile = join(primaryRepo, "dirty-tracked.txt");
    require("node:fs").writeFileSync(trackedFile, "modified before bash");
    execSync("git add dirty-tracked.txt", { cwd: primaryRepo, stdio: "ignore" });
    // Create pre-existing untracked file
    require("node:fs").writeFileSync(join(primaryRepo, "untracked-before.txt"), "dirty");

    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);

    // Verify protectedRepos sees the repo
    const m = await loadManifest(TASK_ID);
    const prot = protectedRepos({ role: "implementer", manifest: m });
    expect(prot.length).toBeGreaterThan(0);
    expect(prot[0].canonical).toBe(realpathSync(primaryRepo));

    const ctx = fakeCtx({ sessionFile: "/i6", cwd: primaryWorktree });

    // tool_call: captures dirty fingerprint
    const prevHead = execSync("git rev-parse HEAD", { cwd: primaryRepo, encoding: "utf8" }).trim();
    await pi.toolCallHandlers[1]({ toolName: "bash", toolCallId: "dr1", input: { command: "echo" } }, ctx);

    // Bash mutates: add another commit on top of dirty repo
    execSync(`git commit --allow-empty -m "${prevHead}agent change"`, { cwd: primaryRepo, stdio: "ignore" });
    const headAfterMut = execSync("git rev-parse HEAD", { cwd: primaryRepo, encoding: "utf8" }).trim();
    expect(headAfterMut).not.toBe(prevHead);

    // tool_result: should report UNSAFE (not reset because repo was dirty)
    const result = await pi.toolResultHandlers[0](
      { toolName: "bash", toolCallId: "dr1", content: [{ type: "text", text: "ok" }], isError: false },
      ctx,
    );
    expect(result).toBeDefined();
    const res = result as { isError?: boolean; content?: { type: string; text: string }[] };
    expect(res.isError).toBe(true);
    const txt = res.content?.[0]?.text ?? "";
    expect(txt).toMatch(/POLICY_VIOLATION_UNSAFE/);

    // Confirm pre-existing dirty file was NOT destroyed (HEAD unchanged after mutation because unsafe — no reset occurred)
    // The agent's mutation persists (because we can't safely isolate), but pre-existing state is intact.
    const currentHead = execSync("git rev-parse HEAD", { cwd: primaryRepo, encoding: "utf8" }).trim();
    // No destructive reset occurred — HEAD is still at the agent mutation commit\    expect(currentHead).toBe(headAfterMut);\    // Pre-existing tracked file was committed in "pre" commit — it survives\    // because unsafe means NO reset\
    expect(require("node:fs").readFileSync(trackedFile, "utf8")).toBe("modified before bash");
    // Pre-existing untracked file survived
    expect(require("node:fs").readFileSync(join(primaryRepo, "untracked-before.txt"), "utf8")).toBe("dirty");
  });
});

describe.serial("Fix 3 - implementer relative paths resolve against session cwd", () => {
  test("relative './' write resolves against worktree cwd", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c7", implementerSessionFile: "/i7" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const ctx = fakeCtx({ sessionFile: "/i7", cwd: primaryWorktree });
    // Write a relative path — should resolve to worktree/* and be allowed
    const r = await pi.toolCallHandlers[0](
      { toolName: "write", toolCallId: "t-rel", input: { path: "./smoke-rel.txt", content: "x" } },
      ctx,
    );
    // Should be allowed (no block)
    expect(r === undefined || !(r as any).block).toBe(true);
  });

  test("relative write from implementer session with wrong cwd is blocked", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c8", implementerSessionFile: "/i8" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    // Session says implementer but cwd points to original source — ./README.md resolves to source, should be blocked
    const ctx = fakeCtx({ sessionFile: "/i8", cwd: primaryRepo });
    const r = await pi.toolCallHandlers[0](
      { toolName: "write", toolCallId: "t-rel-bad", input: { path: "./README.md", content: "x" } },
      ctx,
    );
    expect((r as any).block).toBe(true);
  });

  test("absolute original source path blocked when cwd is worktree", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c9", implementerSessionFile: "/i9" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const ctx = fakeCtx({ sessionFile: "/i9", cwd: primaryWorktree });
    const r = await pi.toolCallHandlers[0](
      { toolName: "write", toolCallId: "t-abs", input: { path: join(primaryRepo, "no-access.ts"), content: "x" } },
      ctx,
    );
    expect((r as any).block).toBe(true);
  });

  test("normalized traversal ./src/../README resolves safely", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/ca", implementerSessionFile: "/ia" });
    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);
    const ctx = fakeCtx({ sessionFile: "/ia", cwd: primaryWorktree });
    const r = await pi.toolCallHandlers[0](
      { toolName: "write", toolCallId: "t-norm", input: { path: "./src/../README.md", content: "x" } },
      ctx,
    );
    // "./src/../README.md" normalizes to "./README.md" relative to worktree — allowed
    expect(r === undefined || !(r as any).block).toBe(true);
  });
});
