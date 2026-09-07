import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ToolCall = { toolName: string; input: unknown };
type GuardContext = { cwd: string };
type Guard = (event: ToolCall, ctx: GuardContext) => unknown;

let fixtureRoot: string;
let repo: string;
let taskRoot: string;
let taskWorktree: string;
let guard: Guard;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function blocked(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("block" in result)) return false;
  return result.block === true;
}

async function check(toolName: "write" | "edit", path: string): Promise<boolean> {
  return blocked(await guard({ toolName, input: { path } }, { cwd: repo }));
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "task-workspace-guard-"));
  repo = join(fixtureRoot, "primary");
  taskRoot = join(fixtureRoot, "tasks");
  taskWorktree = join(taskRoot, "guard-task", "primary");
  await mkdir(repo, { recursive: true });
  await mkdir(taskRoot, { recursive: true });
  process.env.OMP_TASK_ROOT = taskRoot;

  git(fixtureRoot, "init", "-q", repo);
  await writeFile(join(repo, ".gitignore"), "ignored-dir/\n");
  await writeFile(join(repo, "tracked.txt"), "tracked");
  await mkdir(join(repo, "ignored-dir"), { recursive: true });
  await writeFile(join(repo, "ignored-dir", "existing.txt"), "existing");
  await writeFile(join(repo, "ignored-dir", "tracked-ignored.txt"), "tracked ignored");
  await writeFile(join(repo, "untracked.txt"), "untracked");
  git(repo, "add", ".gitignore", "tracked.txt");
  git(repo, "add", "-f", "ignored-dir/tracked-ignored.txt");
  git(repo, "-c", "user.name=Task Workspace Test", "-c", "user.email=task-workspace@example.com", "commit", "-qm", "init");
  await mkdir(join(taskRoot, "guard-task"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "guard-task", taskWorktree);

  const { default: registerTaskWorkspace } = await import("../../../../task-workspace.ts");
  const handlers: Guard[] = [];
  const schema = new Proxy((() => schema) as unknown as object, {
    apply: () => schema,
    get: () => (..._args: unknown[]) => schema,
  });
  const pi = {
    zod: new Proxy({}, { get: () => (..._args: unknown[]) => schema }),
    registerTool: (_tool: unknown) => undefined,
    on: (event: string, handler: Guard) => {
      if (event === "tool_call") handlers.push(handler);
    },
  };
  registerTaskWorkspace(pi as unknown as Parameters<typeof registerTaskWorkspace>[0]);
  guard = handlers[0]!;
});

afterAll(async () => {
  delete process.env.OMP_TASK_ROOT;
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe.serial("Task Workspace primary write guard", () => {
  test("allows write and edit to an existing ignored file in primary", async () => {
    expect(await check("write", join(repo, "ignored-dir", "existing.txt"))).toBe(false);
    expect(await check("edit", join(repo, "ignored-dir", "existing.txt"))).toBe(false);
  });

  test("allows write and edit of a new file inside an ignored directory", async () => {
    const target = join(repo, "ignored-dir", "new.txt");
    expect(await check("write", target)).toBe(false);
    expect(await check("edit", target)).toBe(false);
  });

  test("blocks tracked files in primary, even when ignored", async () => {
    expect(await check("write", join(repo, "tracked.txt"))).toBe(true);
    expect(await check("edit", join(repo, "tracked.txt"))).toBe(true);
    expect(await check("write", join(repo, "ignored-dir", "tracked-ignored.txt"))).toBe(true);
    expect(await check("edit", join(repo, "ignored-dir", "tracked-ignored.txt"))).toBe(true);
  });

  test("blocks an untracked non-ignored file in primary", async () => {
    expect(await check("write", join(repo, "untracked.txt"))).toBe(true);
    expect(await check("edit", join(repo, "untracked.txt"))).toBe(true);
  });

  test("blocks Git metadata under .git", async () => {
    expect(await check("write", join(repo, ".git", "config"))).toBe(true);
    expect(await check("edit", join(repo, ".git", "config"))).toBe(true);
  });

  test("blocks Git metadata under a managed task worktree", async () => {
    for (const target of [join(taskWorktree, ".git"), join(taskWorktree, ".git", "config")]) {
      expect(await check("write", target)).toBe(true);
      expect(await check("edit", target)).toBe(true);
    }
  });
});
