/**
 * Real-shell matrix: ONE bash script — run the way the pi bash tool runs
 * commands (`env PATH=<shim-dir>:… bash -c`, guard env armed exactly like
 * the extension's spawnHook) — exercises every shell form that used to
 * need a hand-rolled lexer. The shim sees only what the shell actually
 * executes: post-`cd` cwd and real argv. Prose containing "git" never
 * invokes the shim; `command git`, `env git`, and `xargs git` DO reach it
 * via PATH resolution. Documented non-blocking blind spots (absolute git
 * path, inline PATH reassignment, sudo/secure_path) are asserted to stay
 * non-blocking.
 */
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "../../../tests/support/expect.ts";
import { resolveGitOnPath } from "../shim-path.ts";
import { createGuardFixture, type GuardFixture } from "./fixture.ts";

const SHIM_PATH = join(import.meta.dirname, "git");
const POLICY_PATH = join(import.meta.dirname, "policy.mjs");

let fx: GuardFixture;

function matrixScript(): string {
  return `set -u
exec 2>&1
# Whole-script stderr is merged into stdout so each === segment carries its
# own shim block messages (the harness segments by those markers).
echo "=== path-head"
echo "\${PATH%%:*}"
echo "=== gh-title"
gh pr create --title "verify git state" 2>&1
echo "rc=$?"
echo "=== echo-git"
echo git commit
echo "rc=$?"
echo "=== dq-git"
"git" commit -m x 2>&1
echo "rc=$?"
echo "=== sq-git"
'git' commit -m x 2>&1
echo "rc=$?"
echo "=== cd-managed"
cd ${fx.managed} && git commit -m x 2>&1
echo "rc=$?"
echo "=== cd-primary"
cd ${fx.primary} && git commit -m x 2>&1
echo "rc=$?"
echo "=== array-paren"
a=(")"); git commit -m x 2>&1
echo "rc=$?"
echo "=== subshell"
echo "$(git commit -m x)" 2>&1
echo "rc=$?"
echo "=== envvar-prefix"
GIT_AUTHOR_NAME=x git commit -m x 2>&1
echo "rc=$?"
echo "=== c-managed"
git -C ${fx.managed} commit -m x 2>&1
echo "rc=$?"
echo "=== c-primary"
git -C ${fx.primary} commit -m x 2>&1
echo "rc=$?"
echo "=== c-chain"
git -C ${fx.parent} -C child rev-parse --show-toplevel 2>&1
echo "rc=$?"
echo "=== c-chain-commit"
git -C ${fx.parent} -C child commit -m x 2>&1
echo "rc=$?"
echo "=== command-status"
command git status --porcelain 2>&1
echo "rc=$?"
echo "=== env-status"
env git status --porcelain 2>&1
echo "rc=$?"
echo "=== command-commit"
command git commit -m x 2>&1
echo "rc=$?"
echo "=== env-commit"
env git commit -m x 2>&1
echo "rc=$?"
echo "=== xargs-branch"
echo x | xargs git branch -D tmp 2>&1
echo "rc=$?"
echo "=== blind-abs"
/usr/bin/git --version 2>&1
echo "rc=$?"
echo "=== blind-path"
PATH=/usr/bin git --version 2>&1
echo "rc=$?"
echo "=== blind-sudo"
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n git --version 2>&1
  echo "rc=$?"
else
  echo "skipped (sudo -n unavailable)"
  echo "rc=skip"
fi
`;
}

let segments: Record<string, string> = {};

// The runner starts sibling hooks without ordering guarantees, so the fixture
// and the matrix run happen in one hook: the matrix reads fx.taskRoot.
beforeAll(async () => {
  chmodSync(SHIM_PATH, 0o755);
  fx = await createGuardFixture("agent-kit-matrix-");
  // Fixture setup spawns dozens of guarded git invocations (measured
  // ~3.5s warm); the default hook timeout leaves no headroom on a loaded
  // machine.
  // Shim-aware real-git resolution, exactly how the extension arms the
  // guard: `command -v git` under a guarded session resolves to a shim
  // copy, and ALLOW segments would exec the shim forever.
  const realGit = resolveGitOnPath(process.env.PATH ?? "");
  if (!realGit) throw new Error("real git not found on PATH");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("AGENT_KIT_") && k !== "AGENT_TASK_ROOT") {
      env[k] = v;
    }
  }
  env.PATH = `${dirname(SHIM_PATH)}:${env.PATH ?? ""}`;
  env.AGENT_TASK_ROOT = fx.taskRoot;
  env.AGENT_KIT_REAL_GIT = realGit;
  env.AGENT_KIT_POLICY_RUNTIME = process.execPath;
  env.AGENT_KIT_POLICY = POLICY_PATH;

  const r = spawnSync("bash", ["-c", matrixScript()], {
    cwd: fx.primary, // session cwd = primary checkout (the incident shape)
    env,
    encoding: "utf8",
  });
  const out = r.stdout;
  segments = {};
  for (const chunk of out.split(/^=== /m).slice(1)) {
    const nl = chunk.indexOf("\n");
    segments[chunk.slice(0, nl)] = chunk.slice(nl + 1);
  }
  if (Object.keys(segments).length === 0) {
    throw new Error(`matrix script produced no segments; output:\n${out}`);
  }
});

afterAll(async () => {
  if (fx) await fx.destroy();
});

const seg = (name: string): string => {
  const s = segments[name];
  if (s === undefined) throw new Error(`missing matrix segment: ${name}`);
  return s;
};

describe("real-shell matrix through the armed bash tool path", () => {
  test("the shim dir is first on PATH in the child", () => {
    expect(seg("path-head").trim()).toBe(dirname(SHIM_PATH));
  });

  test("prose never invokes the shim: gh title and echo args stay silent", () => {
    expect(seg("gh-title")).not.toContain("Blocked:");
    expect(seg("echo-git")).not.toContain("Blocked:");
  });

  test("quoted git command words are caught", () => {
    expect(seg("dq-git")).toContain("Blocked:");
    expect(seg("sq-git")).toContain("Blocked:");
  });

  test("cd idiom routes through the shim: managed allows, primary blocks", () => {
    expect(seg("cd-managed")).not.toContain("Blocked:");
    expect(seg("cd-primary")).toContain("Blocked: mutating git command on primary checkout");
  });

  test("array assignment data is inert but the real argv still runs", () => {
    expect(seg("array-paren")).toContain("Blocked:");
  });

  test("git inside a command substitution is caught", () => {
    expect(seg("subshell")).toContain("Blocked:");
  });

  test("assignment-prefixed git still reaches the policy with the right cwd", () => {
    expect(seg("envvar-prefix")).toContain("Blocked:");
  });

  test("-C forms: managed allows, primary blocks, chained -C resolves to the inner repo", () => {
    expect(seg("c-managed")).not.toContain("Blocked:");
    expect(seg("c-primary")).toContain("Blocked:");
    // Real git itself resolves the chain: rev-parse --show-toplevel prints
    // the inner repo — allowed because read-only — proving left-to-right
    // resolution end-to-end through shell → shim → policy → git.
    const chain = seg("c-chain");
    expect(chain).toContain(fx.child);
    expect(chain).not.toContain("Blocked:");
    // And the mutating variant is blocked AT the inner repo.
    const chainCommit = seg("c-chain-commit");
    expect(chainCommit).toContain("Blocked:");
    expect(chainCommit).toContain(`primary checkout ${fx.child}`);
  });

  test("command git / env git / xargs git ARE caught (PATH resolution)", () => {
    // Read-only variants pass through the shim untouched…
    expect(seg("command-status")).not.toContain("Blocked:");
    expect(seg("env-status")).not.toContain("Blocked:");
    // …and the mutating variants prove those command words reach the shim.
    expect(seg("command-commit")).toContain("Blocked:");
    expect(seg("env-commit")).toContain("Blocked:");
    const xargs = seg("xargs-branch");
    expect(xargs).toContain("Blocked:");
    // xargs reports the failed command: GNU xargs exits 123, BSD xargs
    // (macOS) exits 1 when an invocation exits 1-125.
    expect(xargs).toMatch(/rc=(123|[1-9][0-9]*)/);
  });

  test("documented blind spots stay NON-blocking: absolute path, inline PATH, sudo", () => {
    expect(seg("blind-abs")).toContain("git version");
    expect(seg("blind-abs")).not.toContain("Blocked:");
    expect(seg("blind-path")).toContain("git version");
    expect(seg("blind-path")).not.toContain("Blocked:");
    const sudo = seg("blind-sudo");
    if (!sudo.includes("skipped")) {
      expect(sudo).toContain("git version");
      expect(sudo).not.toContain("Blocked:");
    }
  });
});
