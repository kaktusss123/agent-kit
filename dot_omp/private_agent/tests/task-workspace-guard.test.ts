import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import registerTaskWorkspace from "../extensions/task-workspace";

type ToolCallHandler = (event: unknown, ctx: unknown) => unknown;
type GuardResult = { block?: boolean } | undefined;

function fakeZod(): unknown {
  const z = new Proxy(() => z, {
    get: () => z,
    apply: () => z,
  });
  return z;
}

function mutationGuard(): ToolCallHandler {
  const handlers: ToolCallHandler[] = [];
  const pi = {
    zod: fakeZod(),
    registerTool() {},
    on(event: string, handler: ToolCallHandler) {
      if (event === "tool_call") handlers.push(handler);
    },
  };
  registerTaskWorkspace(pi as never);
  return handlers[0]!;
}

function isBlocked(result: unknown): boolean {
  return Boolean((result as GuardResult)?.block);
}

describe("task workspace mutation guard", () => {
  test("does not classify basename-only anchored edit headers against session cwd", async () => {
    const guard = mutationGuard();
    const result = await guard(
      {
        toolName: "edit",
        input: {
          path: "[12-sample-probe.sh#EDF1]",
          input: "  [12-sample-probe.sh#EDF1]  \nPUT 1.=1:\n+updated",
        },
      },
      { cwd: "/Users/komar/projects/homelab" },
    );

    expect(result).toBeUndefined();
  });

  test("routes outside-git and managed-worktree anchored paths correctly", async () => {
    const taskRoot = realpathSync(process.env.OMP_TASK_ROOT ?? join(homedir(), ".omp", "tasks"));
    const fixtureRoot = await mkdtemp(join(taskRoot, "guard-regression-"));
    const primaryRoot = await mkdtemp(join(tmpdir(), "guard-primary-"));
    const worktreeRoot = join(fixtureRoot, "worktree");

    try {
      execFileSync("git", ["init", "-q", "-b", "main", primaryRoot]);
      execFileSync("git", ["-C", primaryRoot, "config", "user.email", "guard-test@example.invalid"]);
      execFileSync("git", ["-C", primaryRoot, "config", "user.name", "Guard Test"]);
      await writeFile(join(primaryRoot, "README.md"), "fixture\n");
      execFileSync("git", ["-C", primaryRoot, "add", "README.md"]);
      execFileSync("git", ["-C", primaryRoot, "commit", "-qm", "fixture"]);
      execFileSync("git", ["-C", primaryRoot, "worktree", "add", "--detach", worktreeRoot, "HEAD"]);

      const guard = mutationGuard();
      const primary = await guard(
        { toolName: "edit", input: { path: join(primaryRoot, "README.md") } },
        { cwd: primaryRoot },
      );
      const anchoredPrimary = await guard(
        {
          toolName: "edit",
          input: {
            path: `[${join(primaryRoot, "README.md")}#8A60]`,
            input: "[README.md#8A60]\nPUT 1.=1:\n+updated",
          },
        },
        { cwd: primaryRoot },
      );
      const managed = await guard(
        {
          toolName: "edit",
          input: {
            path: `[${join(worktreeRoot, "README.md")}#8A60]`,
            input: "[README.md#8A60]\nPUT 1.=1:\n+updated",
          },
        },
        { cwd: primaryRoot },
      );
      const outsideGit = await guard(
        {
          toolName: "edit",
          input: {
            path: "[ /tmp/rx580-exp/12-sample-probe.sh#EDF1]",
            input: "[12-sample-probe.sh#EDF1]\nPUT 1.=1:\n+updated",
          },
        },
        { cwd: primaryRoot },
      );

      expect(isBlocked(primary)).toBe(true);
      expect(isBlocked(anchoredPrimary)).toBe(true);
      expect(managed).toBeUndefined();
      expect(outsideGit).toBeUndefined();
    } finally {
      try {
        execFileSync("git", ["-C", primaryRoot, "worktree", "remove", "--force", worktreeRoot]);
      } catch {
        // Cleanup below still removes the temporary fixture.
      }
      await rm(primaryRoot, { recursive: true, force: true });
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
