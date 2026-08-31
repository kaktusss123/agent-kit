import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkspace } from "../adapters/git-workspace.ts";
import { createGitExec } from "../adapters/git-exec.ts";
import { ShellVerificationRunner } from "../adapters/shell-verification.ts";
import { LocalProcessHost } from "../adapters/local-process-host.ts";
import { LocalRunDriverHost } from "../adapters/local-run-driver-host.ts";
async function git(cwd: string, args: string[]): Promise<void> { const result = await createGitExec().exec(args, cwd); if (result.exitCode !== 0) throw new Error(result.stderr); }

describe("TCSF adapters", () => {
  test("creates isolated worktrees and captures only worktree changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-workspace-")); const repo = join(root, "repo");
    try {
      await git(root, ["init", repo]); await writeFile(join(repo, "README"), "base\n"); await git(repo, ["add", "."]); await git(repo, ["-c", "user.email=tcsf@example.invalid", "-c", "user.name=TCSF", "commit", "-m", "base"]);
      const baseSha = (await createGitExec().exec(["rev-parse", "HEAD"], repo)).stdout; const workspace = await createGitWorkspace().prepareTaskWorkspaces({ taskId: "t", taskRoot: join(root, "task"), worktreesDir: join(root, "task", "worktrees"), repositories: [{ canonicalPath: repo, baseSha, role: "primary", repoKey: "primary", writableScope: ["*"] }] });
      const entry = workspace.workspaces.get("primary"); expect(entry?.isWorktree).toBe(true); await writeFile(join(entry!.worktreePath!, "changed"), "x\n"); const changes = await createGitWorkspace().captureChanges(workspace); expect(changes.changes.get("primary")?.addedFiles).toContain("changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("runs commands with expected exit codes and bounded artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-verify-"));
    try { const runner = new ShellVerificationRunner({ defaultOutputLimit: 16 }); const result = await runner.run({ taskId: "t", cwd: root, commands: [{ id: "ok", name: "ok", shell: "printf verified", expectedExitCode: 0 }, { id: "expected", name: "expected", shell: "exit 3", expectedExitCode: 3 }], artifactDir: join(root, "artifacts") }); expect(result.passed).toBe(true); expect(result.commandResults[0].stdout).toBe("verified"); expect(result.commandResults[1].passed).toBe(true); } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("terminates timed-out process groups and preserves full logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-timeout-"));
    try { const runner = new ShellVerificationRunner({ terminationGraceMs: 100 }); const result = await runner.run({ taskId: "t", cwd: root, commands: [{ id: "timeout", name: "timeout", shell: "sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait \"$child\"", timeoutSeconds: 0.05 }], artifactDir: join(root, "artifacts") }); const command = result.commandResults[0]; expect(result.passed).toBe(false); expect(command.timedOut).toBe(true); expect(command.cleanupSucceeded).toBe(true); expect(await readFile(join(root, "artifacts", "timeout.stdout.log"), "utf8")).toMatch(/\d+/u); } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("persists exclusive writer leases across host instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-host-"));
    try { const first = new LocalProcessHost(join(root, "state")); const second = new LocalProcessHost(join(root, "state")); const third = new LocalProcessHost(join(root, "state")); const host = await first.start({ executionId: "e", cwd: root, session: "session" }); const lease = await first.acquireWriter(host, { type: "operator", operatorId: "one" }); await expect(second.acquireWriter(host, { type: "operator", operatorId: "two" })).rejects.toThrow("writer lease held"); await second.releaseWriter(lease); const replacement = await third.acquireWriter(host, { type: "operator", operatorId: "two" }); await third.releaseWriter(replacement); await first.stop(host, "force"); } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("renews only the current writer lease generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-renew-writer-"));
    try {
      const first = new LocalProcessHost(join(root, "state")); const second = new LocalProcessHost(join(root, "state")); const host = await first.start({ executionId: "e", cwd: root, session: "session" });
      const lease = await first.acquireWriter(host, { type: "controller", controllerId: "one" });
      const stale = { ...lease, token: "stale-token" };
      await expect(second.renewWriter(stale)).rejects.toThrow("renewal rejected");
      const renewed = await first.renewWriter(lease);
      expect(renewed.generation).toBe(lease.generation);
      await first.releaseWriter(renewed); const replacement = await second.acquireWriter(host, { type: "controller", controllerId: "one" }); await expect(first.renewWriter(renewed)).rejects.toThrow("renewal rejected"); await second.releaseWriter(replacement); await first.stop(host, "force");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("foreground returns a durable lease that can be released", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-foreground-"));
    try {
      const hostAdapter = new LocalProcessHost(join(root, "state")); const host = await hostAdapter.start({ executionId: "e", cwd: root, session: "session" });
      const foreground = await hostAdapter.foreground(host, { operatorId: "operator", capability: "handoff", continuityNonce: "nonce" });
      expect(foreground.writerLease?.token).toBeString(); await expect(hostAdapter.acquireWriter(host, { type: "controller", controllerId: "controller" })).rejects.toThrow("writer lease held");
      await hostAdapter.releaseWriter(foreground.writerLease!); await hostAdapter.acquireWriter(host, { type: "controller", controllerId: "controller" }); await hostAdapter.stop(host, "force");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("runs the driver in its run-owned cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-driver-cwd-"));
    try {
      const script = join(root, "driver-probe.ts");
      await writeFile(script, 'await Bun.write("relative-probe.txt", "ok\\n"); await Bun.sleep(5000);\n');
      const host = new LocalRunDriverHost(root, script);
      const ref = await host.start({ taskId: "task", runId: "run", tcsfHome: root, controllerId: "test", leaseToken: "lease" });
      const manifest = JSON.parse(await readFile(join(root, "tasks", "task", "runs", "run", "driver.json"), "utf8")) as { cwd: string; pid: number };
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(manifest.cwd).toBe(join(root, "tasks", "task", "runs", "run", "driver-cwd"));
      expect(await Bun.file(join(manifest.cwd, "relative-probe.txt")).text()).toBe("ok\n");
      expect(await Bun.file(join(root, "relative-probe.txt")).exists()).toBe(false);
      await host.stop(ref, "force");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
