import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import registerTaskWorkspace from "../extensions/task-workspace";

type ToolCall = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
};

function fakeSchema(): unknown {
  const z = new Proxy(() => z, {
    get: () => z,
    apply: () => z,
  });
  return z;
}

function registerBinding(): Map<string, ToolCall> {
  const tools = new Map<string, ToolCall>();
  registerTaskWorkspace({
    typebox: { Type: fakeSchema() },
    registerTool: (t: never) => tools.set((t as { name: string }).name, t as never),
    on() {},
  } as never);
  return tools;
}

/** Fixture source repo with a bare origin remote, one commit, and local
 *  branches — remotes are resolved before branch attach, exactly like the
 *  pre-split runtime. */
async function makeSourceRepo(prefix: string, branches: string[]): Promise<{
  src: string;
  remote: string;
}> {
  const src = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const remote = await mkdtemp(join(tmpdir(), `${prefix}-remote-`));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", src]);
  execFileSync("git", ["-C", src, "config", "user.email", "details-test@example.invalid"]);
  execFileSync("git", ["-C", src, "config", "user.name", "Details Test"]);
  execFileSync("git", ["-C", src, "remote", "add", "origin", remote]);
  await writeFile(join(src, "README.md"), "fixture\n");
  execFileSync("git", ["-C", src, "add", "README.md"]);
  execFileSync("git", ["-C", src, "commit", "-qm", "init"]);
  for (const branch of branches) {
    execFileSync("git", ["-C", src, "branch", branch]);
  }
  return { src, remote };
}

function payloadOf(res: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe("OMP binding details attachment", () => {
  test("task_status attaches the whole result as details", async () => {
    const tools = registerBinding();
    const res = await tools.get("task_status")!.execute("p", {}, undefined, undefined, {
      cwd: tmpdir(),
    });
    const payload = payloadOf(res);
    expect(payload.classification).toBe("OUTSIDE_GIT");
    expect(res.details).toEqual(payload);
  });

  test("ensure_task_repo attaches {status, worktree} on success outcomes", async () => {
    const identity = `details-ens-${Date.now()}`;
    const branch = `feat/${identity}`;
    const { src, remote } = await makeSourceRepo("details-ens", [branch]);
    const tools = registerBinding();
    try {
      const res = await tools.get("ensure_task_repo")!.execute(
        "p",
        { branch, source_path: src },
        undefined,
        undefined,
        { cwd: src },
      );
      const payload = payloadOf(res);
      expect(payload.status).toBe("attached");
      expect(res.details).toEqual({
        status: "attached",
        worktree: payload.worktree,
      });
      const worktree = payload.worktree as string;
      expect(worktree).toContain(identity);
      execFileSync("git", ["-C", src, "worktree", "remove", "--force", worktree]);
    } finally {
      await cleanupDir(src);
      await cleanupDir(remote);
      await cleanupDir(join(tmpdir(), `feat_${identity}`));
    }
  });

  test("checkpoint_commit attaches the committed subset and nothing on failure", async () => {
    const { src, remote } = await makeSourceRepo("details-commit", []);
    const tools = registerBinding();
    try {
      await writeFile(join(src, "new-file.txt"), "committed\n");
      // A temp-dir fixture classifies as a primary checkout; the explicit
      // allow_primary flag is the documented manual-source-commit exception.
      const ok = await tools.get("checkpoint_commit")!.execute(
        "p",
        { repo: src, paths: ["new-file.txt"], message: "details test", allow_primary: true },
        undefined,
        undefined,
        { cwd: src },
      );
      const payload = payloadOf(ok);
      expect(payload.status).toBe("committed");
      expect(ok.details).toEqual({
        status: "committed",
        commit: payload.commit,
        branch: payload.branch,
        files: payload.files,
      });
      expect(Object.keys(ok.details as object)).toEqual([
        "status",
        "commit",
        "branch",
        "files",
      ]);

      const miss = await tools.get("checkpoint_commit")!.execute(
        "p",
        { repo: src, paths: ["../outside.txt"], message: "outside", allow_primary: true },
        undefined,
        undefined,
        { cwd: src },
      );
      expect(payloadOf(miss).status).toBe("path_outside_repo");
      expect(miss.details).toBeUndefined();
    } finally {
      await cleanupDir(src);
      await cleanupDir(remote);
    }
  });

  test("remove_task_lane attaches the full removed result and nothing on rejection", async () => {
    // The canonical workspace identity is the canonical branch itself; the
    // lane call must address the same workspace via `task`.
    const identity = `feat/details-lane-${Date.now()}`;
    const laneBranch = `${identity}-lane`;
    const { src, remote } = await makeSourceRepo("details-lane", [
      identity,
      laneBranch,
    ]);
    const tools = registerBinding();
    try {
      const canonical = await tools.get("ensure_task_repo")!.execute(
        "p",
        { branch: identity, source_path: src },
        undefined,
        undefined,
        { cwd: src },
      );
      expect(payloadOf(canonical).status).toBe("attached");

      const lane = await tools.get("ensure_task_repo")!.execute(
        "p",
        { branch: laneBranch, source_path: src, task: identity, slot: "dt" },
        undefined,
        undefined,
        { cwd: src },
      );
      const lanePayload = payloadOf(lane);
      expect(lanePayload.status).toBe("attached");

      const removed = await tools.get("remove_task_lane")!.execute(
        "p",
        { task: identity, path: lanePayload.worktree as string },
        undefined,
        undefined,
        { cwd: src },
      );
      const removedPayload = payloadOf(removed);
      expect(removedPayload.status).toBe("removed");
      expect(removed.details).toEqual(removedPayload);

      const rejected = await tools.get("remove_task_lane")!.execute(
        "p",
        { task: identity, path: join(src, "not-a-lane") },
        undefined,
        undefined,
        { cwd: src },
      );
      expect(payloadOf(rejected).status).toBe("lane_rejected");
      expect(rejected.details).toBeUndefined();
    } finally {
      execFileSync("git", ["-C", src, "worktree", "prune"], { stdio: "ignore" });
      await cleanupDir(src);
      await cleanupDir(remote);
      await cleanupDir(join(tmpdir(), identity.replace(/\//g, "_")));
    }
  });
});
