import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { realpath } from "./git";
import { resolveTaskRoot } from "./task-root";

const RESOLVER_ENTRY = join(import.meta.dir, "task-root.ts");

function withTempRoot(run: (root: string) => void): void {
  // realpathSync: on macOS /var is a symlink to /private/var, and the
  // resolver's walk-up realpath resolves the first EXISTING ancestor — the
  // temp root itself — so expectations must be stated in real-path space.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "task-root-")));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the resolver in a fresh process with an explicit environment — the
 *  only way to prove $HOME handling, because os.homedir() snapshots $HOME
 *  per process and an ambient AGENT_TASK_ROOT must not leak. */
function resolveInSubprocess(env: Record<string, string>): string {
  // No-argument call: the subprocess resolves against its own process.env.
  const script = `const m = await import(${JSON.stringify(RESOLVER_ENTRY)}); console.log(m.resolveTaskRoot());`;
  return execFileSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
  }).trim();
}

describe("task-root resolution", () => {
  test("AGENT_TASK_ROOT is used when set", () => {
    withTempRoot((root) => {
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: root })).toBe(realpathSync(root));
    });
  });

  test("default is ~/.agent-kit/tasks", () => {
    // Structural pin against the ambient process home. Uses the core
    // non-throwing realpath (walk-up): the default root need not exist yet.
    expect(resolveTaskRoot({})).toBe(realpath(join(homedir(), ".agent-kit", "tasks")));
  });

  test("unknown legacy env vars are ignored — no compatibility alias", () => {
    withTempRoot((legacy) => {
      expect(resolveTaskRoot({ OMP_TASK_ROOT: legacy })).toBe(
        realpath(join(homedir(), ".agent-kit", "tasks")),
      );
    });
  });

  test("default follows $HOME (fresh process, clean environment)", () => {
    // Real-path space for the same /var → /private/var reason as
    // withTempRoot: the walk-up realpath resolves the existing fakeHome.
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "task-root-home-")));
    try {
      expect(resolveInSubprocess({ HOME: fakeHome })).toBe(
        join(fakeHome, ".agent-kit", "tasks"),
      );
      expect(resolveInSubprocess({ HOME: fakeHome, AGENT_TASK_ROOT: "~/boxed" })).toBe(
        join(fakeHome, "boxed"),
      );
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("tilde values expand against the home directory", () => {
    expect(resolveTaskRoot({ AGENT_TASK_ROOT: "~" })).toBe(homedir());
    expect(resolveTaskRoot({ AGENT_TASK_ROOT: "~/tasks/box" })).toBe(
      join(homedir(), "tasks", "box"),
    );
  });

  test("empty or whitespace values fall through to the default", () => {
    expect(resolveTaskRoot({ AGENT_TASK_ROOT: "" })).toBe(
      realpath(join(homedir(), ".agent-kit", "tasks")),
    );
    expect(resolveTaskRoot({ AGENT_TASK_ROOT: "   " })).toBe(
      realpath(join(homedir(), ".agent-kit", "tasks")),
    );
  });

  test("a configured root that does not exist yet stays a stable path", () => {
    withTempRoot((base) => {
      const fresh = join(base, "first-task-not-created", "tasks");
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: fresh })).toBe(fresh);
    });
  });

  test("a symlinked root resolves to the real path", () => {
    withTempRoot((real) => {
      const link = join(tmpdir(), `task-root-link-${Date.now()}-${process.pid}`);
      symlinkSync(real, link);
      try {
        expect(resolveTaskRoot({ AGENT_TASK_ROOT: link })).toBe(realpathSync(real));
      } finally {
        rmSync(link, { force: true });
      }
    });
  });
});
