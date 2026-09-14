/**
 * Shared fixture topology for the shim/policy test suite. Mirrors the
 * former guard fixture recipe: bare remote + primary source repo + managed
 * worktree via ensureTaskRepo + one plain linked worktree + nested
 * parent/child repos. Fixtures live under $HOME/.cache — NEVER /tmp, which
 * the policy treats as scratch space (temporary roots always pass).
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureTaskRepo } from "../flows";

export interface GuardFixture {
  root: string;
  taskRoot: string;
  /** Session cwd / primary checkout (has a managed worktree). */
  primary: string;
  /** Managed worktree under taskRoot. */
  managed: string;
  /** Managed worktree of the CHILD repo under taskRoot. */
  childManaged: string;
  /** Linked worktree OUTSIDE the task root (other linked worktree). */
  otherWorktree: string;
  /** Nested repo pair: child is its own repo inside parent. */
  parent: string;
  child: string;
  destroy: () => Promise<void>;
}

export async function createGuardFixture(prefix: string): Promise<GuardFixture> {
  const cacheDir = join(homedir(), ".cache");
  await mkdir(cacheDir, { recursive: true });
  const root = realpathSync(await mkdtemp(join(cacheDir, prefix)));
  const taskRoot = join(root, "tasks");
  const primary = join(root, "primary");
  await mkdir(taskRoot, { recursive: true });

  const remotePath = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remotePath]);
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  execFileSync("git", ["-C", primary, "config", "user.email", "guard@example.invalid"]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Guard Fixture"]);
  execFileSync("git", ["-C", primary, "remote", "add", "origin", remotePath]);
  await writeFile(join(primary, "README.md"), "guard fixture\n");
  execFileSync("git", ["-C", primary, "add", "README.md"]);
  execFileSync("git", ["-C", primary, "commit", "-qm", "init"]);
  execFileSync("git", ["-C", primary, "branch", "feat/fixture"]);

  const result = await ensureTaskRepo(
    { branch: "feat/fixture", source_path: primary },
    primary,
    { taskRoot },
  );
  const managed = (result as { worktree: string }).worktree;
  if (!managed.startsWith(taskRoot)) {
    throw new Error(`fixture managed worktree not under task root: ${managed}`);
  }

  const otherWorktree = join(root, "other-wt");
  execFileSync(
    "git",
    ["-C", primary, "worktree", "add", "-q", "-b", "other/branch", otherWorktree],
  );

  // Nested repos: a repo inside a repo proves left-to-right -C chaining.
  const parent = join(root, "parent");
  execFileSync("git", ["init", "-q", "-b", "main", parent]);
  execFileSync("git", ["-C", parent, "config", "user.email", "guard@example.invalid"]);
  execFileSync("git", ["-C", parent, "config", "user.name", "Guard Fixture"]);
  await writeFile(join(parent, "p.txt"), "parent\n");
  execFileSync("git", ["-C", parent, "add", "p.txt"]);
  execFileSync("git", ["-C", parent, "commit", "-qm", "parent"]);
  const child = join(parent, "child");
  execFileSync("git", ["init", "-q", "-b", "main", child]);
  execFileSync("git", ["-C", child, "config", "user.email", "guard@example.invalid"]);
  execFileSync("git", ["-C", child, "config", "user.name", "Guard Fixture"]);
  execFileSync("git", ["-C", child, "remote", "add", "origin", join(root, "child-remote.git")]);
  execFileSync("git", ["init", "-q", "--bare", join(root, "child-remote.git")]);
  await writeFile(join(child, "c.txt"), "child\n");
  execFileSync("git", ["-C", child, "add", "c.txt"]);
  execFileSync("git", ["-C", child, "commit", "-qm", "child"]);
  execFileSync("git", ["-C", child, "branch", "feat/child"]);

  // Managed worktree of the CHILD repo: makes a chained -C resolution into
  // child observably BLOCK at the policy level.
  const childManagedResult = await ensureTaskRepo(
    { branch: "feat/child", source_path: child },
    child,
    { taskRoot },
  );
  const childManaged = (childManagedResult as { worktree: string }).worktree;
  if (!childManaged || !childManaged.startsWith(taskRoot)) {
    throw new Error(`fixture child managed worktree invalid: ${JSON.stringify(childManagedResult)}`);
  }

  return {
    root,
    taskRoot,
    primary,
    managed,
    childManaged,
    otherWorktree,
    parent,
    child,
    destroy: () => rm(root, { recursive: true, force: true }),
  };
}
