import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitExec } from "../adapters/git-exec.ts";
import { createGitWorkspace } from "../adapters/git-workspace.ts";

async function git(cwd: string, args: string[]): Promise<string> { const result = await createGitExec().exec(args, cwd); return result.stdout; }

test("capture detects committed out-of-scope worktree changes and restores only the isolated worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "tcsf-workspace-safety-")); const repo = join(root, "repo");
  try {
    await git(root, ["init", repo]); await writeFile(join(repo, "README"), "base\n"); await git(repo, ["add", "."]); await git(repo, ["-c", "user.email=tcsf@example.invalid", "-c", "user.name=TCSF", "commit", "-m", "base"]); const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const workspaceSet = await createGitWorkspace().prepareTaskWorkspaces({ taskId: "task", taskRoot: join(root, "task"), worktreesDir: join(root, "task", "worktrees"), repositories: [{ repoKey: "primary", canonicalPath: repo, baseSha, role: "primary", writableScope: ["src/**"] }] }); const worktree = workspaceSet.workspaces.get("primary")!.worktreePath!;
    await writeFile(join(worktree, "outside"), "bad\n"); await git(worktree, ["add", "outside"]); await git(worktree, ["-c", "user.email=tcsf@example.invalid", "-c", "user.name=TCSF", "commit", "-m", "unauthorized"]); const changeSet = await createGitWorkspace().captureChanges(workspaceSet); const change = changeSet.changes.get("primary")!; expect(change.committedFiles).toContain("outside"); expect(change.unauthorizedFiles).toContain("outside"); expect(change.isAuthorized).toBe(false);
    const restored = await createGitWorkspace().restoreUnauthorizedChanges({ workspaceSet, changeSet, unauthorizedRepos: ["primary"] }); expect(restored.allSucceeded).toBe(true); expect(await Bun.file(join(worktree, "outside")).exists()).toBe(false); expect((await git(worktree, ["rev-parse", "HEAD"])).trim()).toBe(baseSha.trim());
  } finally { await rm(root, { recursive: true, force: true }); }
});
