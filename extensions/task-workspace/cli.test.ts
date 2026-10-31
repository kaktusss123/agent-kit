/**
 * CLI binding (cli.ts) — the Claude Code surface of the shared core.
 *
 * Covers the A9/W1 acceptance scenarios through the real `bun cli.ts`
 * process, parity with the pi binding's tool results for the same calls,
 * and the W3 hooks: PreToolUse write verdicts and the SessionStart env file
 * that arms the git PATH shim. Guard fixtures live under $HOME/.cache —
 * never /tmp, which the guard treats as scratch space.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = join(import.meta.dir, "cli.ts");
const SHIM_DIR = join(import.meta.dir, "shim");

const cacheDir = join(homedir(), ".cache");
mkdirSync(cacheDir, { recursive: true });
const ROOT = realpathSync(mkdtempSync(join(cacheDir, "agent-kit-cli-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
function fresh(name: string): string {
  const dir = join(ROOT, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sh(cwd: string, ...cmd: string[]): string {
  return execFileSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" }).trim();
}

/** Local-only repo (no remote) with one commit on main, checked out on a side branch. */
function makeRepo(base: string): { source: string; taskRoot: string } {
  const source = join(base, "src");
  const taskRoot = join(base, "tasks");
  mkdirSync(source, { recursive: true });
  sh(source, "git", "init", "-q", "-b", "main");
  sh(source, "git", "config", "user.email", "cli@example.invalid");
  sh(source, "git", "config", "user.name", "CLI");
  writeFileSync(join(source, "README.md"), "init\n");
  sh(source, "git", "add", "-A");
  sh(source, "git", "commit", "-qm", "init");
  sh(source, "git", "checkout", "-qb", "side-work");
  return { source, taskRoot };
}

function cli(
  args: string[],
  opts: { cwd: string; taskRoot: string; input?: string; env?: Record<string, string> },
): { code: number; json: Record<string, unknown> | null; stdout: string } {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, AGENT_TASK_ROOT: opts.taskRoot, ...opts.env },
  });
  const stdout = proc.stdout ?? "";
  let json: Record<string, unknown> | null = null;
  try {
    json = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { code: proc.status ?? -1, json, stdout };
}

function worktreeCount(repo: string): number {
  return sh(repo, "git", "worktree", "list").split("\n").length;
}

describe("task CLI acceptance (A9 W1)", () => {
  test("ensure without base_ref in a local-only repo → base_selection_required, nothing created", () => {
    const { source, taskRoot } = makeRepo(fresh("base"));
    const r = cli(["ensure", JSON.stringify({ branch: "feat/cli_base", source_path: source })], {
      cwd: source,
      taskRoot,
    });
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe("base_selection_required");
    expect(worktreeCount(source)).toBe(1);
    expect(sh(source, "git", "branch", "--list", "feat/cli_base")).toBe("");
  });

  test("repeated ensure of the same task identity → reused, same path", () => {
    const { source, taskRoot } = makeRepo(fresh("reuse"));
    const params = JSON.stringify({ branch: "feat/cli_reuse", source_path: source, base_ref: "main" });
    const first = cli(["ensure", params], { cwd: source, taskRoot });
    expect(first.code).toBe(0);
    expect(first.json?.status).toBe("created");
    const second = cli(["ensure", params], { cwd: source, taskRoot });
    expect(second.json?.status).toBe("reused");
    expect(second.json?.worktree).toBe(first.json?.worktree);
    // params from stdin are equivalent
    const third = cli(["ensure", "-"], { cwd: source, taskRoot, input: params });
    expect(third.json?.status).toBe("reused");
  });

  test("commit in the primary checkout without allow_primary → primary_commit_blocked", () => {
    const { source, taskRoot } = makeRepo(fresh("primary"));
    writeFileSync(join(source, "change.txt"), "x\n");
    const head = sh(source, "git", "rev-parse", "HEAD");
    const r = cli(
      ["commit", JSON.stringify({ repo: source, paths: ["change.txt"], message: "chore: x" })],
      { cwd: source, taskRoot },
    );
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe("primary_commit_blocked");
    expect(sh(source, "git", "rev-parse", "HEAD")).toBe(head);
  });

  test("commit with a secret-like path → secret_path_rejected", () => {
    const { source, taskRoot } = makeRepo(fresh("secret"));
    const ensured = cli(
      ["ensure", JSON.stringify({ branch: "feat/cli_secret", source_path: source, base_ref: "main" })],
      { cwd: source, taskRoot },
    );
    const wt = ensured.json?.worktree as string;
    writeFileSync(join(wt, "credentials.json"), "{}\n");
    const r = cli(
      ["commit", JSON.stringify({ repo: wt, paths: ["credentials.json"], message: "chore: x" })],
      { cwd: wt, taskRoot },
    );
    expect(r.json?.status).toBe("secret_path_rejected");
  });

  test("usage errors exit 2 without running a flow", () => {
    const { source, taskRoot } = makeRepo(fresh("usage"));
    expect(cli(["nope"], { cwd: source, taskRoot }).code).toBe(2);
    expect(cli(["ensure", "{not json"], { cwd: source, taskRoot }).code).toBe(2);
    expect(cli(["commit", JSON.stringify({ repo: source, message: "m" })], { cwd: source, taskRoot }).code).toBe(2);
  });
});

describe("task current (read-only projection)", () => {
  const current = (cwd: string, taskRoot: string, params: unknown) =>
    cli(["current", JSON.stringify(params)], { cwd, taskRoot });
  const ensureTask = (source: string, taskRoot: string, branch: string) =>
    cli(["ensure", JSON.stringify({ branch, source_path: source, base_ref: "main" })], { cwd: source, taskRoot })
      .json as { task: string; worktree: string };

  test("empty or absent selections and a neutral cwd → none", () => {
    const base = fresh("cur-none");
    const { source, taskRoot } = makeRepo(base);
    for (const params of [{ cwd: source }, { cwd: source, selections: [] }]) {
      const r = current(source, taskRoot, params);
      expect(r.code).toBe(0);
      expect(r.json).toEqual({ state: "none", identity: null, workspace: null, source: null, repos: [] });
    }
  });

  test("a selection of a real workspace → ok with repo facts and empty owners", () => {
    const { source, taskRoot } = makeRepo(fresh("cur-ok"));
    const e = ensureTask(source, taskRoot, "feat/cur_ok");
    const r = current(source, taskRoot, { cwd: source, selections: [{ task: e.task, worktree: e.worktree }] });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ state: "ok", identity: "feat/cur_ok", source: "session" });
    const repos = r.json!.repos as { owners: unknown[] }[];
    expect(repos).toHaveLength(1);
    expect(repos[0]!.owners).toEqual([]);
  });

  test("a vanished workspace → missing, identity retained", () => {
    const { source, taskRoot } = makeRepo(fresh("cur-missing"));
    const r = current(source, taskRoot, { cwd: source, selections: [{ task: "feat_gone", worktree: join(taskRoot, "feat_gone", "x") }] });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ state: "missing", identity: "feat_gone", source: "session", repos: [] });
  });

  test("managed cwd wins over selections; otherwise the last selection wins", () => {
    const { source, taskRoot } = makeRepo(fresh("cur-win"));
    const a = ensureTask(source, taskRoot, "feat/cur_a");
    const b = ensureTask(source, taskRoot, "feat/cur_b");
    const sels = [
      { task: a.task, worktree: a.worktree },
      { task: b.task, worktree: b.worktree },
    ];
    expect(current(source, taskRoot, { cwd: a.worktree, selections: [sels[1]] }).json).toMatchObject({ identity: "feat/cur_a", source: "cwd" });
    expect(current(source, taskRoot, { cwd: source, selections: sels }).json).toMatchObject({ identity: "feat/cur_b", source: "session" });
    expect(current(source, taskRoot, { cwd: source, selections: [...sels].reverse() }).json).toMatchObject({ identity: "feat/cur_a" });
  });

  test("malformed params → exit 2", () => {
    const { source, taskRoot } = makeRepo(fresh("cur-usage"));
    const bad: unknown[] = [
      {},
      { cwd: "relative/path" },
      { cwd: 5 },
      { cwd: source, selections: "x" },
      { cwd: source, selections: [{ task: "t" }] },
      { cwd: source, selections: [null] },
    ];
    for (const p of bad) expect(current(source, taskRoot, p).code).toBe(2);
    expect(cli(["current", "{not json"], { cwd: source, taskRoot }).code).toBe(2);
  });
});

// ─── parity with the pi binding ───────────────────────────────────────────

type ToolDef = {
  name: string;
  execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) => Promise<{
    content: { text: string }[];
  }>;
};

function loadPiTools(taskRoot: string): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool: (def: ToolDef) => tools.set(def.name, def),
    on: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const prev = process.env.AGENT_TASK_ROOT;
  process.env.AGENT_TASK_ROOT = taskRoot;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./index.ts").default as (pi: ExtensionAPI) => void)(pi);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TASK_ROOT;
    else process.env.AGENT_TASK_ROOT = prev;
  }
  return tools;
}

async function piCall(tools: Map<string, ToolDef>, name: string, params: unknown, cwd: string) {
  const res = await tools.get(name)!.execute("t", params, undefined, undefined, { cwd });
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

describe("CLI and pi binding return identical statuses (shared core)", () => {
  test("base_selection_required, created/reused, primary_commit_blocked, secret_path_rejected", async () => {
    const { source, taskRoot } = makeRepo(fresh("parity"));
    const tools = loadPiTools(taskRoot);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["ensure_task_repo", "ensure", { branch: "feat/parity_a", source_path: source }],
      ["checkpoint_commit", "commit", { repo: source, paths: ["README.md"], message: "chore: p" }],
      ["checkpoint_commit", "commit", { repo: source, paths: [".env"], message: "chore: p", allow_primary: true }],
    ];
    for (const [tool, op, params] of cases) {
      const viaPi = await piCall(tools, tool, params, source);
      const viaCli = cli([op, JSON.stringify(params)], { cwd: source, taskRoot }).json;
      expect(viaCli?.status).toBe(viaPi.status);
    }
    const ensure = { branch: "feat/parity_b", source_path: source, base_ref: "main" };
    const created = await piCall(tools, "ensure_task_repo", ensure, source);
    const reused = cli(["ensure", JSON.stringify(ensure)], { cwd: source, taskRoot }).json;
    expect(created.status).toBe("created");
    expect(reused?.status).toBe("reused");
    expect(reused?.worktree).toBe(created.worktree);
  }, 30_000);
});

// ─── Claude Code hooks (A9 W3) ────────────────────────────────────────────

describe("PreToolUse write guard", () => {
  test("Edit of a tracked primary-checkout file is denied only when managed worktrees exist", () => {
    const { source, taskRoot } = makeRepo(fresh("pretool"));
    const input = (tool: string, file: string) =>
      JSON.stringify({ tool_name: tool, tool_input: { file_path: file }, cwd: source });

    const before = cli(["hook", "pre-tool-use"], { cwd: source, taskRoot, input: input("Edit", "README.md") });
    expect(before.code).toBe(0);
    expect(before.stdout.trim()).toBe("");

    const ensured = cli(
      ["ensure", JSON.stringify({ branch: "feat/cli_guard", source_path: source, base_ref: "main" })],
      { cwd: source, taskRoot },
    );
    const wt = ensured.json?.worktree as string;

    const blocked = cli(["hook", "pre-tool-use"], { cwd: source, taskRoot, input: input("Edit", "README.md") });
    const out = blocked.json?.hookSpecificOutput as Record<string, string>;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain(wt);

    const inWorktree = cli(["hook", "pre-tool-use"], {
      cwd: source,
      taskRoot,
      input: input("Write", join(wt, "README.md")),
    });
    expect(inWorktree.stdout.trim()).toBe("");
  });

  test("malformed hook input fails open", () => {
    const { source, taskRoot } = makeRepo(fresh("pretool-bad"));
    const r = cli(["hook", "pre-tool-use"], { cwd: source, taskRoot, input: "not json" });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

describe("SessionStart arms the git shim through CLAUDE_ENV_FILE", () => {
  test("sourced env file blocks primary-checkout commits and --no-verify, passes read-only git", () => {
    const base = fresh("session");
    const { source, taskRoot } = makeRepo(base);
    const ensured = cli(
      ["ensure", JSON.stringify({ branch: "feat/cli_shim", source_path: source, base_ref: "main" })],
      { cwd: source, taskRoot },
    );
    const wt = ensured.json?.worktree as string;
    const envFile = join(base, "claude-env");
    writeFileSync(envFile, "");
    const r = cli(["hook", "session-start"], {
      cwd: source,
      taskRoot,
      input: "{}",
      env: { CLAUDE_ENV_FILE: envFile },
    });
    expect(r.code).toBe(0);
    const exports = readFileSync(envFile, "utf8");
    expect(exports).toContain(`export PATH='${SHIM_DIR}'":$PATH"`);
    expect(exports).toContain("AGENT_KIT_REAL_GIT=");

    const run = (cwd: string, script: string) =>
      spawnSync("sh", ["-c", `. '${envFile}' && ${script}`], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, AGENT_TASK_ROOT: "" },
      });
    writeFileSync(join(source, "README.md"), "changed\n");
    const status = run(source, "git status --short");
    expect(status.status).toBe(0);
    const commit = run(source, "git commit -qam 'primary'");
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain(wt);

    writeFileSync(join(wt, "README.md"), "changed\n");
    const noVerify = run(wt, "git commit -qam 'x' --no-verify");
    expect(noVerify.status).not.toBe(0);
    expect(noVerify.stderr).toContain("--no-verify");
    const ok = run(wt, "git commit -qam 'feat: managed'");
    expect(ok.status).toBe(0);
  }, 30_000);

  test("without CLAUDE_ENV_FILE nothing is written and the hook succeeds", () => {
    const { source, taskRoot } = makeRepo(fresh("session-none"));
    const r = cli(["hook", "session-start"], { cwd: source, taskRoot, input: "{}", env: { CLAUDE_ENV_FILE: "" } });
    expect(r.code).toBe(0);
  });

  test("the CLI strips the shim from its own PATH so its flows run real git", () => {
    const { source, taskRoot } = makeRepo(fresh("strip"));
    cli(["ensure", JSON.stringify({ branch: "feat/cli_strip_a", source_path: source, base_ref: "main" })], {
      cwd: source,
      taskRoot,
    });
    // A second ensure mutates the primary repo (worktree add); with the shim
    // first on PATH and armed it would be blocked if the CLI used it.
    const r = cli(
      ["ensure", JSON.stringify({ branch: "feat/cli_strip_b", source_path: source, base_ref: "main" })],
      {
        cwd: source,
        taskRoot,
        env: {
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          AGENT_KIT_REAL_GIT: sh(source, "sh", "-c", "command -v git"),
          AGENT_KIT_POLICY_RUNTIME: process.execPath,
          AGENT_KIT_POLICY: join(SHIM_DIR, "policy.mjs"),
        },
      },
    );
    expect(r.json?.status).toBe("created");
    expect(existsSync(r.json?.worktree as string)).toBe(true);
  });
});
