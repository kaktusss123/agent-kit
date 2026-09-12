import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { realpath } from "../extensions/task-workspace/git";
import { resolveTaskRoot } from "../extensions/task-workspace/task-root";

const RESOLVER_ENTRY = join(
  import.meta.dir,
  "..",
  "extensions",
  "task-workspace",
  "task-root.ts",
);

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "task-root-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the resolver in a fresh process with an explicit environment — the
 *  only way to prove $HOME handling, because os.homedir() snapshots $HOME
 *  per process and ambient AGENT_TASK_ROOT/OMP_TASK_ROOT must not leak. */
function resolveInSubprocess(env: Record<string, string>): string {
  // No-argument call: the subprocess resolves against its own process.env.
  const script = `const m = await import(${JSON.stringify(RESOLVER_ENTRY)}); console.log(m.resolveTaskRoot());`;
  return execFileSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
  }).trim();
}

describe("shared task-root resolution (harness-agnostic)", () => {
  test("generic AGENT_TASK_ROOT is used when set", () => {
    withTempRoot((root) => {
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: root })).toBe(realpathSync(root));
    });
  });

  test("generic AGENT_TASK_ROOT beats legacy OMP_TASK_ROOT", () => {
    withTempRoot((generic) => {
      withTempRoot((legacy) => {
        expect(
          resolveTaskRoot({ AGENT_TASK_ROOT: generic, OMP_TASK_ROOT: legacy }),
        ).toBe(realpathSync(generic));
      });
    });
  });

  test("legacy OMP_TASK_ROOT still works when generic root is absent", () => {
    withTempRoot((legacy) => {
      expect(resolveTaskRoot({ OMP_TASK_ROOT: legacy })).toBe(realpathSync(legacy));
    });
  });

  test("default is the historical ~/.omp/tasks — never a harness-specific root", () => {
    // Structural pin against the ambient process home. Uses the core
    // non-throwing realpath (walk-up): the default root need not exist yet.
    expect(resolveTaskRoot({})).toBe(realpath(join(homedir(), ".omp", "tasks")));
    expect(
      resolveTaskRoot({ OMP_AGENT_DIR: "/harness/omp", PI_AGENT_DIR: "/harness/pi" }),
    ).toBe(realpath(join(homedir(), ".omp", "tasks")));
  });

  test("default follows $HOME on Linux (fresh process, clean environment)", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "task-root-home-"));
    try {
      expect(resolveInSubprocess({ HOME: fakeHome })).toBe(join(fakeHome, ".omp", "tasks"));
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
    expect(resolveTaskRoot({ OMP_TASK_ROOT: "~/legacy-box" })).toBe(
      join(homedir(), "legacy-box"),
    );
  });

  test("empty or whitespace values fall through to the next precedence level", () => {
    withTempRoot((legacy) => {
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: "", OMP_TASK_ROOT: legacy })).toBe(
        realpathSync(legacy),
      );
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: "   ", OMP_TASK_ROOT: legacy })).toBe(
        realpathSync(legacy),
      );
    });
    expect(resolveTaskRoot({ AGENT_TASK_ROOT: "", OMP_TASK_ROOT: "" })).toBe(
      realpath(join(homedir(), ".omp", "tasks")),
    );
  });

  test("a configured root that does not exist yet stays a stable path", () => {
    withTempRoot((base) => {
      const fresh = join(base, "first-task-not-created", "tasks");
      expect(resolveTaskRoot({ AGENT_TASK_ROOT: fresh })).toBe(fresh);
    });
  });

  test("a symlinked root resolves to the real path — same location for every harness", () => {
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

  test("generic root wins even when harness-specific dirs are configured", () => {
    withTempRoot((generic) => {
      expect(
        resolveTaskRoot({
          AGENT_TASK_ROOT: generic,
          OMP_AGENT_DIR: "/harness/omp",
          PI_AGENT_DIR: "/harness/pi",
          OPENCODE_CONFIG_DIR: "/harness/opencode",
        }),
      ).toBe(realpathSync(generic));
    });
  });
});
