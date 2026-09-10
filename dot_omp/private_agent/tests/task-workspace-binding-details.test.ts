import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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

/**
 * Register the production binding against a disposable task root.
 *
 * The binding resolves its task root at registration time, so the env var is
 * set only around the register call and restored immediately afterwards —
 * correctness never depends on import order or module cache. The real
 * ~/.omp/tasks is neither read as fixture root nor mutated.
 */
async function registerIsolatedBinding(): Promise<{
  tools: Map<string, ToolCall>;
  taskRoot: string;
}> {
  const taskRoot = realpathSync(await mkdtemp(join(tmpdir(), "tw-details-root-")));
  const previous = process.env.OMP_TASK_ROOT;
  process.env.OMP_TASK_ROOT = taskRoot;
  try {
    const tools = new Map<string, ToolCall>();
    registerTaskWorkspace({
      typebox: { Type: fakeSchema() },
      registerTool: (t: never) => tools.set((t as { name: string }).name, t as never),
      on() {},
    } as never);
    return { tools, taskRoot };
  } finally {
    if (previous === undefined) delete process.env.OMP_TASK_ROOT;
    else process.env.OMP_TASK_ROOT = previous;
  }
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

interface FixtureCleanup {
  taskRoot: string;
  src: string;
  remote: string;
  /** Flattened workspace directory under taskRoot, when one was created. */
  workspaceDir?: string;
  /** Worktrees created through the binding, force-removed via their source. */
  worktrees: { repo: string; path: string }[];
}

/** Guaranteed teardown: worktrees, git metadata, repos, remote, task root —
 *  force flags are fixture cleanup only, never product behavior. */
async function cleanupFixture(fx: FixtureCleanup): Promise<void> {
  for (const wt of fx.worktrees) {
    try {
      execFileSync("git", ["-C", wt.repo, "worktree", "remove", "--force", wt.path]);
    } catch {
      // Already removed (e.g. the lane scenario removes its own lane).
    }
  }
  try {
    execFileSync("git", ["-C", fx.src, "worktree", "prune"]);
  } catch {
    // Source repo may already be gone on exotic failure paths.
  }
  await rm(fx.src, { recursive: true, force: true });
  await rm(fx.remote, { recursive: true, force: true });
  if (fx.workspaceDir !== undefined) {
    await rm(fx.workspaceDir, { recursive: true, force: true });
  }
  await rm(fx.taskRoot, { recursive: true, force: true });
}

describe("OMP binding details attachment (isolated task root)", () => {
  test("task_status attaches the whole result as details", async () => {
    const { tools, taskRoot } = await registerIsolatedBinding();
    const res = await tools.get("task_status")!.execute("p", {}, undefined, undefined, {
      cwd: tmpdir(),
    });
    const payload = payloadOf(res);
    expect(payload.classification).toBe("OUTSIDE_GIT");
    expect(res.details).toEqual(payload);
    await rm(taskRoot, { recursive: true, force: true });
  });

  test("ensure_task_repo attaches {status, worktree} under the isolated root", async () => {
    const identity = `details-ens-${Date.now()}`;
    const branch = `feat/${identity}`;
    const { src, remote } = await makeSourceRepo("details-ens", [branch]);
    const { tools, taskRoot } = await registerIsolatedBinding();
    const fx: FixtureCleanup = {
      taskRoot,
      src,
      remote,
      workspaceDir: join(taskRoot, `feat_${identity}`),
      worktrees: [],
    };
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
      // Regression guard: the binding must materialize the worktree inside
      // the injected temporary root, never inside the real ~/.omp/tasks.
      expect(worktree.startsWith(taskRoot), `${worktree} outside isolated root`).toBe(true);
      fx.worktrees.push({ repo: src, path: worktree });
    } finally {
      await cleanupFixture(fx);
    }
  });

  test("checkpoint_commit attaches the committed subset and nothing on failure", async () => {
    const { src, remote } = await makeSourceRepo("details-commit", []);
    const { tools, taskRoot } = await registerIsolatedBinding();
    const fx: FixtureCleanup = { taskRoot, src, remote, worktrees: [] };
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
      await cleanupFixture(fx);
    }
  });

  test("remove_task_lane attaches the full removed result; canonical and lane are cleaned up", async () => {
    // The canonical workspace identity is the canonical branch itself; the
    // lane call must address the same workspace via `task`.
    const identity = `feat/details-lane-${Date.now()}`;
    const laneBranch = `${identity}-lane`;
    const { src, remote } = await makeSourceRepo("details-lane", [
      identity,
      laneBranch,
    ]);
    const { tools, taskRoot } = await registerIsolatedBinding();
    const fx: FixtureCleanup = {
      taskRoot,
      src,
      remote,
      workspaceDir: join(taskRoot, identity.replace(/\//g, "_")),
      worktrees: [],
    };
    try {
      const canonical = await tools.get("ensure_task_repo")!.execute(
        "p",
        { branch: identity, source_path: src },
        undefined,
        undefined,
        { cwd: src },
      );
      const canonicalPayload = payloadOf(canonical);
      expect(canonicalPayload.status).toBe("attached");
      expect(
        (canonicalPayload.worktree as string).startsWith(taskRoot),
        "canonical worktree outside isolated root",
      ).toBe(true);
      fx.worktrees.push({
        repo: src,
        path: canonicalPayload.worktree as string,
      });

      const lane = await tools.get("ensure_task_repo")!.execute(
        "p",
        { branch: laneBranch, source_path: src, task: identity, slot: "dt" },
        undefined,
        undefined,
        { cwd: src },
      );
      const lanePayload = payloadOf(lane);
      expect(lanePayload.status).toBe("attached");
      expect(
        (lanePayload.worktree as string).startsWith(taskRoot),
        "lane worktree outside isolated root",
      ).toBe(true);

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
      await cleanupFixture(fx);
    }
  });
});
