import { execFileSync } from "node:child_process";
import { realpathSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const CORE_DIR = join(import.meta.dir, "..", "extensions", "task-workspace");

describe("task-workspace core host independence", () => {
  test("core modules import and run without any host context", async () => {
    // Dynamic import is intentional (module-loading boundary exception): the
    // subject under test IS the bare-context load of the core — each module
    // must import and run with no fake pi, no OMP SDK, no extension plumbing.
    const gitCore = await import("../extensions/task-workspace/git");
    const guardCore = await import("../extensions/task-workspace/guard");
    const flowsCore = await import("../extensions/task-workspace/flows");
    const taskRootCore = await import("../extensions/task-workspace/task-root");

    expect(typeof gitCore.classifyPath).toBe("function");
    expect(typeof gitCore.scanTaskWorkspaces).toBe("function");
    expect(typeof guardCore.parseGitInvocations).toBe("function");
    expect(typeof guardCore.guardManagedWriteTarget).toBe("function");
    expect(typeof flowsCore.ensureTaskRepo).toBe("function");
    expect(typeof flowsCore.checkpointCommit).toBe("function");
    expect(typeof taskRootCore.resolveTaskRoot).toBe("function");

    // Pure classification works with no host wiring at all.
    expect(guardCore.parseGitInvocations("git status")[0]?.mutating).toBe(false);
    expect(guardCore.parseGitInvocations("git push origin main")[0]?.operationClass).toBe(
      "external-side-effect",
    );
    expect(guardCore.parseGitInvocations("git add -A")[0]?.mutating).toBe(true);
  });

  test("core sources never reference the OMP/Pi SDK, host plumbing, or task-root policy", () => {
    // task-root.ts is the single deliberate exception: it IS the task-root
    // policy owned by the task subsystem (AGENT_TASK_ROOT → legacy
    // OMP_TASK_ROOT → default), so reading the environment is its job. It
    // must still stay harness-free: no OMP/Pi SDK imports and no host
    // plumbing. Test files are excluded like in the pi twin of this test.
    const hostPlumbing =
      /\bExtensionAPI\b|\bExtensionContext\b|registerTool|\btypebox\b|\bpi\.on\b|\bctx\.cwd\b/;
    const taskRootPolicy = /OMP_TASK_ROOT|\.omp|process\.env/;
    for (const file of readdirSync(CORE_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    )) {
      const src = readFileSync(join(CORE_DIR, file), "utf8");
      expect(
        src.includes("@oh-my-pi") || src.includes("pi-coding-agent"),
        `${file} must not import the OMP/Pi SDK`,
      ).toBe(false);
      expect(
        hostPlumbing.test(src),
        `${file} must not reference host plumbing`,
      ).toBe(false);
      if (file === "task-root.ts") continue;
      expect(
        taskRootPolicy.test(src),
        `${file} must not reference host task-root configuration`,
      ).toBe(false);
    }
  });

  test("core follows an injected task root — second-host shape, no OMP env", async () => {
    const gitCore = await import("../extensions/task-workspace/git");
    const flowsCore = await import("../extensions/task-workspace/flows");

    // realpathSync mirrors the OMP binding's own task-root resolution
    // contract (macOS /var -> /private/var must not create prefix drift).
    const hostRoot = realpathSync(await mkdtemp(join(tmpdir(), "host2-root-")));
    const sourceRepo = await mkdtemp(join(tmpdir(), "host2-src-"));
    const remotePath = await mkdtemp(join(tmpdir(), "host2-remote-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", remotePath]);
      execFileSync("git", ["init", "-q", "-b", "main", sourceRepo]);
      execFileSync("git", ["-C", sourceRepo, "config", "user.email", "host2@example.invalid"]);
      execFileSync("git", ["-C", sourceRepo, "config", "user.name", "Host Two"]);
      execFileSync("git", ["-C", sourceRepo, "remote", "add", "origin", remotePath]);
      await writeFile(join(sourceRepo, "README.md"), "host2\n");
      execFileSync("git", ["-C", sourceRepo, "add", "README.md"]);
      execFileSync("git", ["-C", sourceRepo, "commit", "-qm", "init"]);
      execFileSync("git", ["-C", sourceRepo, "branch", "feat/host2"]);

      // Workspace path math follows the injected root, not any default.
      expect(gitCore.taskWorkspacePath("some/task", hostRoot)).toBe(
        join(hostRoot, "some_task"),
      );

      // A real flow materializes the workspace under the injected root.
      const result = await flowsCore.ensureTaskRepo(
        { branch: "feat/host2", source_path: sourceRepo },
        sourceRepo,
        { taskRoot: hostRoot },
      );
      expect(result).toMatchObject({ status: "attached" });
      const worktree = (result as { worktree: string }).worktree;
      expect(worktree.startsWith(hostRoot)).toBe(true);

      // Classification and scanning are rooted at the injected root: the
      // created worktree classifies as managed, the source repo does not.
      expect(gitCore.classifyPath(worktree, sourceRepo, hostRoot)).toBe(
        "MANAGED_TASK_WORKTREE",
      );
      expect(gitCore.classifyPath(sourceRepo, sourceRepo, hostRoot)).toBe(
        "PRIMARY_CHECKOUT",
      );
      const scan = await gitCore.scanTaskWorkspaces(hostRoot);
      // scanTaskWorkspaces lists one entry per workspace directory (the
      // flattened branch) inside the injected root.
      expect(scan.length).toBe(1);
      expect(scan[0]!.workspace).toBe(join(hostRoot, "feat_host2"));
      expect(scan[0]!.repos.map((r) => r.path)).toContain(worktree);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
      await rm(sourceRepo, { recursive: true, force: true });
      await rm(remotePath, { recursive: true, force: true });
    }
  });
});
