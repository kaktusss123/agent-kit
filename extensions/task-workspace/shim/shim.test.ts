/**
 * Shim integration tests: the REAL shim script run as a subprocess with a
 * controlled environment, asserting the full mechanism — block message +
 * exit 1 on primary mutations, transparent real-git passthrough (stdio,
 * exit codes, stdin) on allow, and fail-open when the guard environment is
 * absent. Fixture under $HOME/.cache, mirroring the policy tests.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGuardFixture, type GuardFixture } from "./fixture";

const SHIM_PATH = join(import.meta.dir, "git");
const POLICY_PATH = join(import.meta.dir, "policy.mjs");

let fx: GuardFixture;
let realGit: string;
let shimEnv: Record<string, string>;

beforeAll(() => {
  // Independent of checkout state: the shim must be executable on disk.
  chmodSync(SHIM_PATH, 0o755);
  realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit) throw new Error("real git not found on PATH");
});

afterAll(async () => {
  if (fx) await fx.destroy();
});

/** Guard environment armed like the extension's spawnHook, with the shim
 *  dir FIRST on PATH (proving the fail-open path skips the shim itself). */
function buildEnv(withGuard: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("AGENT_KIT_") && k !== "AGENT_TASK_ROOT") {
      env[k] = v;
    }
  }
  env.PATH = `${dirname(SHIM_PATH)}:${env.PATH ?? ""}`;
  if (withGuard) {
    env.AGENT_TASK_ROOT = fx.taskRoot;
    env.AGENT_KIT_REAL_GIT = realGit;
    env.AGENT_KIT_POLICY_RUNTIME = process.execPath;
    env.AGENT_KIT_POLICY = POLICY_PATH;
  }
  return env;
}

function runShim(
  cwd: string,
  args: string[],
  opts: { env: Record<string, string>; input?: string },
) {
  return spawnSync(SHIM_PATH, args, {
    cwd,
    env: opts.env,
    input: opts.input,
    encoding: "utf8",
  });
}

describe("shim subprocess: block", () => {
  beforeAll(async () => {
    fx = await createGuardFixture("agent-kit-shim-block-");
    shimEnv = buildEnv(true);
  });

  test("primary mutation: block message on stderr, exit 1, names root and hint", () => {
    const r = runShim(fx.primary, ["commit", "-m", "x"], { env: shimEnv });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Blocked: mutating git command on primary checkout");
    expect(r.stderr).toContain(fx.primary);
    expect(r.stderr).toContain(fx.managed);
    expect(r.stderr).toContain("routing failure, not a bypass authorization");
  });

  test("--no-verify is blocked even in the managed worktree", () => {
    const r = runShim(fx.managed, ["commit", "--no-verify", "-m", "x"], {
      env: shimEnv,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("checkpoint_commit");
  });
});

describe("shim subprocess: transparent passthrough on allow", () => {
  beforeAll(async () => {
    fx = await createGuardFixture("agent-kit-shim-pass-");
    shimEnv = buildEnv(true);
  });

  test("rev-parse --show-toplevel runs real git in the managed worktree", () => {
    const r = runShim(fx.managed, ["rev-parse", "--show-toplevel"], { env: shimEnv });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${fx.managed}\n`);
  });

  test("status --porcelain passes through with exit 0", () => {
    const r = runShim(fx.managed, ["status", "--porcelain"], { env: shimEnv });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("stdin reaches real git (hash-object --stdin)", () => {
    const r = runShim(fx.managed, ["hash-object", "--stdin"], {
      env: shimEnv,
      input: "hello\n",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("real git failure exit codes and stderr pass through", () => {
    const r = runShim(fx.managed, ["rev-parse", "--verify", "no-such-ref"], {
      env: shimEnv,
    });
    expect(r.status).toBe(128);
    expect(r.stderr).toContain("fatal:");
  });

  test("-C into the primary blocks, -C into the managed worktree allows", () => {
    const blocked = runShim(fx.managed, ["-C", fx.primary, "commit", "-m", "x"], {
      env: shimEnv,
    });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("primary checkout");
    const allowed = runShim(fx.primary, ["-C", fx.managed, "add", "-A"], {
      env: shimEnv,
    });
    expect(allowed.status).toBe(0);
  });
});

describe("shim subprocess: fail open without the guard environment", () => {
  beforeAll(async () => {
    fx = await createGuardFixture("agent-kit-shim-open-");
    shimEnv = buildEnv(false);
  });

  test("git works unguarded with a short stderr note, despite the shim being first on PATH", () => {
    const r = runShim(fx.primary, ["rev-parse", "--show-toplevel"], { env: shimEnv });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${fx.primary}\n`);
    expect(r.stderr).toContain("guard environment missing; running unguarded git");
  });

  test("a mutation that would have been blocked now runs real git", () => {
    const r = runShim(fx.primary, ["status"], { env: shimEnv });
    expect(r.status).toBe(0);
  });
});

let hygieneFx: GuardFixture;

describe("shim script hygiene", () => {
  beforeAll(async () => {
    hygieneFx = await createGuardFixture("agent-kit-shim-hygiene-");
  });
  afterAll(() => hygieneFx.destroy());

  test("shim is executable and policy/classify are plain ESM modules", () => {
    const src = readFileSync(SHIM_PATH, "utf8") as string;
    expect(src.startsWith("#!")).toBe(true);
    // The shim must stay dumb: no git classification in shell.
    expect(src).not.toMatch(/READ_ONLY|LOCAL_MUTATION|ref-mutation/);
  });

  test("policy module is runnable under the node runtime too", () => {
    // pi may run under bun, but the policy must not depend on bun APIs.
    // Run plain node against the fixture primary with NO AGENT_TASK_ROOT:
    // an unconfigured task root fails mutations closed.
    const r = spawnSync("node", [POLICY_PATH, hygieneFx.primary, "commit", "-m", "x"], {
      env: { ...process.env, AGENT_TASK_ROOT: "" },
      encoding: "utf8",
    });
    expect(r.stdout).toContain("BLOCK");
    expect(r.status).toBe(0);
  });
});
