/** Real Pi loader and isolated RPC proof for docs/read-only-state.md. No LLM calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
// Use Pi's actual loader, including its SDK aliases, rather than a lookalike.
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry).href);
// Resolve jiti from Pi's package, not an unrelated globally installed copy.
const require = createRequire(piEntry);
const { createJiti } = await import(require.resolve("jiti"));
const KEY = Symbol.for("agentkit.read-only-state.v1");
const scope = globalThis as Record<symbol, any>;
const subagentsEntry = join(root, "extensions/subagents/index.ts");
const taskEntry = join(root, "extensions/task-workspace/index.ts");
const none = { state: "none", identity: null, workspace: null, source: null, repos: [] };

async function emit(extension: any, event: string, cwd?: string) {
  for (const handler of extension.handlers.get(event) ?? []) {
    await handler({ type: event }, { cwd, sessionManager: { getBranch: () => [] } });
  }
}

test("actual Pi entry graphs publish independent sources and survive stale shutdown after reload", { timeout: 60000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "core-loader-"));
  const previousRoot = process.env.AGENT_TASK_ROOT;
  process.env.AGENT_TASK_ROOT = join(scratch, "tasks");
  const loaded: any[] = [];
  try {
    delete scope[KEY];
    const first = await loadExtensions([subagentsEntry, taskEntry], scratch);
    assert.deepEqual(first.errors, []);
    loaded.push(...first.extensions);
    const registry = scope[KEY];
    const oldSubagents = registry.subagents;
    const oldTask = registry.taskWorkspace;
    assert.equal(registry.schemaVersion, 1);
    assert.equal(oldSubagents.version, 1);
    assert.equal(oldTask.version, 1);
    assert.deepEqual(oldSubagents.read(), { status: "ok", activity: "idle", agents: [] });
    assert.deepEqual(await oldTask.read(), { status: "unavailable", reason: "no_session" });
    await emit(first.extensions[1], "session_start", scratch);
    const initial = await oldTask.read();
    assert.equal(initial.status, "ok");
    assert.deepEqual(initial.projection, none);

    // Each call goes through Pi's uncached per-entry loader (the reload path).
    const second = await loadExtensions([subagentsEntry, taskEntry], scratch);
    assert.deepEqual(second.errors, []);
    loaded.push(...second.extensions);
    assert.equal(scope[KEY], registry);
    assert.notEqual(registry.subagents.owner, oldSubagents.owner);
    assert.notEqual(registry.taskWorkspace.owner, oldTask.owner);
    const currentTask = registry.taskWorkspace;
    const currentSubagents = registry.subagents;
    const pending = oldTask.read();
    // Invoke the real new entry's session handler before pending projection work.
    const bind = emit(second.extensions[1], "session_start", scratch);
    await bind;
    assert.ok(currentTask.sessionGeneration() > initial.generation);
    assert.deepEqual(await pending, { status: "unavailable", reason: "session_changed" });

    await emit(first.extensions[0], "session_shutdown");
    await emit(first.extensions[1], "session_shutdown");
    assert.equal(registry.subagents, currentSubagents);
    assert.equal(registry.taskWorkspace, currentTask);
    assert.deepEqual((await currentTask.read()).projection, none);
    await emit(second.extensions[0], "session_shutdown");
    assert.equal(registry.subagents, undefined);
    assert.equal(registry.taskWorkspace, currentTask);
    await emit(second.extensions[1], "session_shutdown");
    assert.equal(registry.taskWorkspace, undefined);
  } finally {
    for (const extension of loaded) await emit(extension, "session_shutdown");
    delete scope[KEY];
    delete scope[Symbol.for("agentkit.inspection")];
    delete scope[Symbol.for("agentkit.task-workspace.inspection")];
    if (previousRoot === undefined) delete process.env.AGENT_TASK_ROOT;
    else process.env.AGENT_TASK_ROOT = previousRoot;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Pi's jiti forced-transform graphs reject a gated stale read and keep replacement ownership", { timeout: 60000 }, async () => {
  // Bundled Pi uses tryNative:false. Force it here even on Node with native TS.
  const graph = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false });
  const sourcePath = join(root, "extensions/task-workspace/read-only-state.ts");
  const first = await graph().import(sourcePath);
  const second = await graph().import(sourcePath);
  const children = await graph().import(join(root, "extensions/subagents/read-only-state.ts"));
  try {
    delete scope[KEY];
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    first.publishTaskWorkspaceStateSource({ taskRoot: root, project: async () => {
      entered();
      await gate;
      return none;
    } });
    children.publishSubagentStateSource(() => [{ id: "child", label: "child", state: "running", alive: true }]);
    const registry = scope[KEY];
    assert.equal(registry.subagents.read().activity, "active");
    first.bindTaskWorkspaceSession({ cwd: root, branchEntries: () => [] });
    const old = registry.taskWorkspace;
    const pending = old.read();
    await started;
    let releaseCurrent!: () => void;
    let enterCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const currentStarted = new Promise<void>((resolve) => { enterCurrent = resolve; });
    second.publishTaskWorkspaceStateSource({ taskRoot: root, project: async () => {
      enterCurrent();
      await currentGate;
      return none;
    } });
    second.bindTaskWorkspaceSession({ cwd: root, branchEntries: () => [] });
    const replacement = registry.taskWorkspace;
    assert.notEqual(replacement.owner, old.owner);
    const currentGeneration = replacement.sessionGeneration();
    const currentPending = replacement.read();
    await currentStarted;
    first.clearTaskWorkspaceSession();
    first.withdrawTaskWorkspaceStateSource();
    assert.equal(replacement.sessionGeneration(), currentGeneration);
    assert.equal(registry.taskWorkspace, replacement);
    releaseCurrent();
    assert.equal((await currentPending).status, "ok");
    release();
    assert.deepEqual(await pending, { status: "unavailable", reason: "session_changed" });
    assert.deepEqual((await replacement.read()).projection, none);
    children.withdrawSubagentStateSource();
    assert.equal(registry.subagents, undefined);
    assert.equal(registry.taskWorkspace, replacement);
    second.withdrawTaskWorkspaceStateSource();
    assert.equal(registry.taskWorkspace, undefined);
  } finally {
    delete scope[KEY];
  }
});

test("real Pi RPC observes both Core entrypoints before and after command-driven reload without model turns", { timeout: 90000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "core-rpc-"));
  const home = join(scratch, "home");
  const agentDir = join(home, ".pi/agent");
  const cwd = join(scratch, "project");
  for (const dir of [agentDir, cwd]) mkdirSync(dir, { recursive: true });
  const observer = join(scratch, "observer.ts");
  // Foreign consumer: it imports no Core modules and only reads the public ABI.
  writeFileSync(observer, `
export default function (pi) {
  const key = Symbol.for("agentkit.read-only-state.v1");
  pi.registerCommand("contract-read", { handler: async () => {
    const registry = globalThis[key];
    if (registry?.schemaVersion !== 1 || registry.subagents?.version !== 1 || registry.taskWorkspace?.version !== 1)
      throw new Error("Core source ABI unavailable");
    const record = registry.taskWorkspace;
    const task = await record.read();
    if (globalThis[key]?.taskWorkspace !== record || task.generation !== record.sessionGeneration())
      throw new Error("stale task read");
    process.stdout.write(JSON.stringify({ type: "contract_probe", subagents: registry.subagents.read(), task }) + "\\n");
  } });
  pi.registerCommand("contract-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
}
`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    PI_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    AGENT_TASK_ROOT: join(scratch, "tasks"),
    JITI_CACHE_DIR: join(scratch, "jiti"),
    PI_SKIP_VERSION_CHECK: "1",
  };
  const cli = fileURLToPath(new URL("./bundle/cli.js", piEntry));
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", subagentsEntry, "-e", taskEntry, "-e", observer], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const diagnosticLines = createInterface({ input: child.stderr });
  const messages: any[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  lines.on("line", (line) => {
    try { messages.push(JSON.parse(line)); } catch { /* Pi may print non-protocol diagnostics. */ }
  });
  // RPC deliberately redirects extension stdout to stderr; only our tagged
  // observer frames are evidence there, never arbitrary diagnostic JSON.
  diagnosticLines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "contract_probe") messages.push(message);
    } catch { /* Ordinary diagnostic text. */ }
  });
  const wait = async (predicate: (message: any) => boolean) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      assert.equal(child.exitCode, null, `Pi exited: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`Pi RPC timed out: ${stderr}`);
  };
  const request = async (id: string, type: string, extra = {}) => {
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    const response = await wait((message) => message.type === "response" && message.id === id);
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  };
  try {
    await request("ready", "get_state");
    await request("before", "prompt", { message: "/contract-read" });
    const before = await wait((message) => message.type === "contract_probe");
    assert.deepEqual(before.subagents, { status: "ok", activity: "idle", agents: [] });
    assert.equal(before.task.status, "ok");
    assert.deepEqual(before.task.projection, none);
    await request("reload", "prompt", { message: "/contract-reload" });
    await request("after", "prompt", { message: "/contract-read" });
    const after = await wait((message) => message.type === "contract_probe" && message.task.generation > before.task.generation);
    assert.deepEqual(after.subagents, before.subagents);
    assert.deepEqual(after.task.projection, none);
    assert.equal(messages.filter((message) => message.type === "agent_start").length, 0);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally {
      clearTimeout(kill);
      lines.close();
      diagnosticLines.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
