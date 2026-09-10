import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import registerTaskWorkspace from "../extensions/task-workspace";
import { parseGitInvocations } from "../extensions/task-workspace/guard";

type ToolCallHandler = (event: unknown, ctx: unknown) => unknown;
type GuardResult = { block?: boolean } | undefined;

function fakeSchema(): unknown {
  const z = new Proxy(() => z, {
    get: () => z,
    apply: () => z,
  });
  return z;
}

function mutationGuard(): ToolCallHandler {
  const handlers: ToolCallHandler[] = [];
  const pi = {
    typebox: { Type: fakeSchema() },
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

/** Fixture: primary repo with one managed worktree under the task root, so
 *  guard verdicts that need a managed-worktree hint can be observed. */
async function withGuardFixture(
  run: (primaryRoot: string, worktreeRoot: string) => Promise<void>,
): Promise<void> {
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

    await run(primaryRoot, worktreeRoot);
  } finally {
    try {
      execFileSync("git", ["-C", primaryRoot, "worktree", "remove", "--force", worktreeRoot]);
    } catch {
      // Cleanup below still removes the temporary fixture.
    }
    await rm(primaryRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

  test("routes outside-git and anchored edit paths per current classification", async () => {
    await withGuardFixture(async (primaryRoot, worktreeRoot) => {
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
      const outsideTemporary = await guard(
        {
          toolName: "edit",
          input: {
            path: "/tmp/rx580-exp/12-sample-probe.sh",
            input: "[12-sample-probe.sh#EDF1]\nPUT 1.=1:\n+updated",
          },
        },
        { cwd: primaryRoot },
      );
      const anchoredOutside = await guard(
        {
          toolName: "edit",
          input: {
            path: "[ /tmp/rx580-exp/12-sample-probe.sh#EDF1]",
            input: "[12-sample-probe.sh#EDF1]\nPUT 1.=1:\n+updated",
          },
        },
        { cwd: primaryRoot },
      );

      // Plain absolute primary write is blocked and hinted.
      expect(isBlocked(primary)).toBe(true);
      expect(isBlocked(anchoredPrimary)).toBe(true);
      // Outside-git temporary targets stay writable (temporary allow).
      expect(outsideTemporary).toBeUndefined();
      // Known gap (pre-existing on main, verified identical on the
      // pre-refactor extension): the guard does not parse `[path#TAG]`
      // edit anchors. An anchored path is classified as a raw string
      // against the session cwd, which resolves under the primary checkout
      // here — so anchored managed-worktree and anchored outside-git
      // writes are conservatively blocked (fail closed, with false
      // positives). Re-introducing anchor extraction is a separate
      // behavior change; tracked as a follow-up.
      expect(isBlocked(managed)).toBe(true);
      expect(isBlocked(anchoredOutside)).toBe(true);
    });
  });

  test("bash guard allows branch queries and blocks branch mutations on primary", async () => {
    await withGuardFixture(async (primaryRoot) => {
      const guard = mutationGuard();
      const run = (command: string) =>
        guard({ toolName: "bash", input: { command } }, { cwd: primaryRoot });

      // Read-only branch forms stay allowed.
      expect(isBlocked(await run("git branch"))).toBe(false);
      expect(isBlocked(await run("git branch --show-current"))).toBe(false);
      expect(isBlocked(await run("git branch -a"))).toBe(false);
      expect(isBlocked(await run("git branch -v"))).toBe(false);
      expect(isBlocked(await run("git branch --contains HEAD"))).toBe(false);
      expect(isBlocked(await run("git branch --list foo*"))).toBe(false);

      // Mutating branch forms are blocked on the primary checkout.
      expect(isBlocked(await run("git branch new-name"))).toBe(true);
      expect(isBlocked(await run("git branch -d old-name"))).toBe(true);
      expect(isBlocked(await run("git branch -D old-name"))).toBe(true);
      expect(isBlocked(await run("git branch --delete old-name"))).toBe(true);
      expect(isBlocked(await run("git branch -m old new"))).toBe(true);
      expect(isBlocked(await run("git branch -M old new"))).toBe(true);
      expect(isBlocked(await run("git branch --move old new"))).toBe(true);
      expect(isBlocked(await run("git branch --copy old new"))).toBe(true);
      expect(isBlocked(await run("git branch --edit-description topic"))).toBe(true);
      expect(isBlocked(await run("git branch --set-upstream-to origin/main"))).toBe(true);
      expect(isBlocked(await run("git branch --unset-upstream"))).toBe(true);
    });
  });
});

describe("git branch operation classification", () => {
  const opClass = (command: string) =>
    parseGitInvocations(command)[0]?.operationClass;

  test("plain git branch and query forms stay read-only", () => {
    expect(opClass("git branch")).toBe("read-only");
    for (const command of [
      "git branch --show-current",
      "git branch --list",
      "git branch --list foo*",
      "git branch -a",
      "git branch -r",
      "git branch -l",
      "git branch -v",
      "git branch -vv",
      "git branch --contains HEAD",
      "git branch --no-merged main",
      "git branch --merged main",
      "git branch --points-at HEAD",
      "git branch --sort=-committerdate",
      "git branch --format=%(refname:short)",
      "git branch --column",
      "git branch -a --contains HEAD~1",
      "git branch --all --verbose --list dev*",
    ]) {
      expect(opClass(command), command).toBe("read-only");
    }
  });

  test("branch mutation forms classify as local/ref-mutation", () => {
    for (const command of [
      "git branch new-name",
      "git branch feat/x origin/main",
      "git branch -d old-name",
      "git branch -D old-name",
      "git branch --delete old-name",
      "git branch -m renamed",
      "git branch -m old new",
      "git branch -M old new",
      "git branch --move old new",
      "git branch --copy a b",
      "git branch -c a b",
      "git branch -C a b",
      "git branch --edit-description topic",
      "git branch --set-upstream-to=origin/main",
      "git branch --set-upstream-to origin/main",
      "git branch -u origin/main",
      "git branch --unset-upstream",
      "git branch --track origin/main topic",
      "git branch --force topic origin/main",
      "git branch -f topic origin/main",
    ]) {
      expect(opClass(command), command).toBe("local/ref-mutation");
    }
  });

  test("unknown branch flags fail closed as ambiguous", () => {
    expect(opClass("git branch --some-future-flag")).toBe("ambiguous");
    expect(opClass("git branch --no-track topic upstream")).toBe("ambiguous");
  });
});
