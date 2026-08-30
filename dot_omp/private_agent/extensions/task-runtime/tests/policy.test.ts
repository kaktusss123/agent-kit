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

describe.serial("registerWritePolicy — bash rollback on cracker worktree mutation", () => {
  test("detects worktree mutation for cracker session and returns CRACKER_READ_ONLY", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c5", implementerSessionFile: "/i5" });
    // Initialize primaryWorktree as a real git repo so fingerprinting works.
    execSync("git init && git commit --allow-empty -m wt-init", { cwd: primaryWorktree, stdio: "ignore" });
    const m = await loadManifest(TASK_ID);
    const wtHead = execSync("git rev-parse HEAD", { cwd: primaryWorktree, encoding: "utf8" }).trim();
    m.repos[m.primaryRepo].baseSha = wtHead;
    await saveManifest(m);

    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);

    // Verify protectedRepos returns worktree, not source
    const m2 = await loadManifest(TASK_ID);
    const prot = protectedRepos({ role: "cracker", manifest: m2 });
    // protectedRepos skips repos without worktreePath — our manifest has one, so >0
    expect(prot.length).toBeGreaterThan(0);
    expect(prot[0].canonical).toBe(realpathSync(primaryWorktree));

    const bashH = pi.toolCallHandlers[1];
    const ctx = fakeCtx({ sessionFile: "/c5", cwd: primaryWorktree });
    await bashH!({ toolName: "bash", toolCallId: "br-mut", input: { command: "echo" } }, ctx);

    // Bash mutation in worktree: create a tracked change
    execSync("git commit --allow-empty -m mutation", { cwd: primaryWorktree, stdio: "ignore" });

    const result = await pi.toolResultHandlers[0](
      { toolName: "bash", toolCallId: "br-mut", content: [{ type: "text", text: "ok" }], isError: false },
      ctx,
    );
    expect(result).toBeDefined();
    const res = result as { isError?: boolean; content?: { type: string; text: string }[] };

    expect(res.content?.[0]?.text ?? "").toMatch(/CRACKER_READ_ONLY/);
  });
});

describe.serial("registerWritePolicy — bash rollback on dirty worktree", () => {
  test("pre-existing dirty worktree prevents destructive reset for cracker", async () => {
    await seedManifestWithRoles({ crackerSessionFile: "/c6", implementerSessionFile: "/i6" });
    // Initialize worktree as real git repo with pre-existing dirty state
    execSync("git init && git commit --allow-empty -m wt-init", { cwd: primaryWorktree, stdio: "ignore" });
    // Pre-existing untracked file in worktree
    execSync("touch untracked-before.txt", { cwd: primaryWorktree, stdio: "ignore" });
    execSync("touch dirty-tracked.txt && git add dirty-tracked.txt && git commit -m dirty-pre", { cwd: primaryWorktree, stdio: "ignore" });
    execSync("echo modified > dirty-tracked.txt && git add dirty-tracked.txt", { cwd: primaryWorktree, stdio: "ignore" });

    const m = await loadManifest(TASK_ID);
    m.repos[m.primaryRepo].baseSha = execSync("git rev-parse HEAD", { cwd: primaryWorktree, encoding: "utf8" }).trim();
    await saveManifest(m);

    const pi = fakePi(realExec());
    registerWritePolicy(pi as unknown as never);

    // Verify protectedRepos returns worktree
    const m2 = await loadManifest(TASK_ID);
    const prot = protectedRepos({ role: "cracker", manifest: m2 });
    expect(prot.length).toBeGreaterThan(0);
    expect(prot[0].canonical).toBe(realpathSync(primaryWorktree));

    const ctx = fakeCtx({ sessionFile: "/c6", cwd: primaryWorktree });

    // tool_call: captures dirty fingerprint
    const prevHead = execSync("git rev-parse HEAD", { cwd: primaryWorktree, encoding: "utf8" }).trim();
    await pi.toolCallHandlers[1]({ toolName: "bash", toolCallId: "dr1", input: { command: "echo" } }, ctx);

    // Bash mutates: add another commit
    execSync("git commit --allow-empty -m 'agent change'", { cwd: primaryWorktree, stdio: "ignore" });
    const headAfterMut = execSync("git rev-parse HEAD", { cwd: primaryWorktree, encoding: "utf8" }).trim();
    expect(headAfterMut).not.toBe(prevHead);

    // tool_result: should report CRACKER_READ_ONLY (rollback to baseSha)
    const result = await pi.toolResultHandlers[0](
      { toolName: "bash", toolCallId: "dr1", content: [{ type: "text", text: "ok" }], isError: false },
      ctx,
    );
    expect(result).toBeDefined();
    const res = result as { isError?: boolean; content?: { type: string; text: string }[] };
    expect(res.isError).toBe(true);
    const txt = res.content?.[0]?.text ?? "";
    expect(txt).toMatch(/CRACKER_READ_ONLY/);
    expect(txt).toMatch(/restored/);
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
