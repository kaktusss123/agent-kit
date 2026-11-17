import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const cli = fileURLToPath(new URL("./bundle/cli.js", piEntry));
const extension = resolve(import.meta.dirname, "index.ts");

test("RPC delivers reminders in model context on prompts eight and sixteen across reload", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflection-rpc-"));
  const home = join(dir, "home"), agent = join(home, ".pi/agent"), cwd = join(dir, "project");
  const skill = join(cwd, ".agents/skills/example");
  mkdirSync(agent, { recursive: true }); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: example\ndescription: Example skill.\n---\n\nExample instructions.\n");
  const fake = join(dir, "fake.ts");
  writeFileSync(fake, `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerCommand("probe-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("probe-tree", { handler: async (id, ctx) => { await ctx.navigateTree(id, { summarize: false }); } });
  pi.registerProvider("reflection-test", { baseUrl: "http://localhost", apiKey: "test", api: "openai-completions", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 100 }],
    streamSimple(model, context) { process.stderr.write("REFLECTION_CONTEXT " + JSON.stringify({ count: (JSON.stringify(context.messages).match(/Optional: consider using the reflect skill/g) || []).length }) + "\\n"); const stream = createAssistantMessageEventStream(); const message = { role: "assistant", content: [{type: "text", text: "ok"}], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }; queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); }); return stream; }
  });
}
`);
  const env = { PATH: process.env.PATH, HOME: home, PI_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", JITI_CACHE_DIR: join(dir, "jiti") };
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session-dir", join(dir, "sessions"), "--no-extensions", "--no-prompt-templates", "--approve", "--provider", "reflection-test", "--model", "fake", "-e", extension, "-e", fake], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const messages: any[] = []; let stderr = "";
  const contexts: number[] = [];
  lines.on("line", line => { try { messages.push(JSON.parse(line)); } catch {} });
  child.stderr.on("data", data => { stderr += data; });
  const diagnosticLines = createInterface({ input: child.stderr });
  diagnosticLines.on("line", line => { if (line.startsWith("REFLECTION_CONTEXT ")) contexts.push(JSON.parse(line.slice(19)).count); });
  async function wait(predicate: (m: any) => boolean) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const m = messages.find(predicate); if (m) return m;
      assert.equal(child.exitCode, null, stderr);
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail(`RPC timeout: ${stderr} ${JSON.stringify(messages.slice(-5))}`);
  }
  async function request(id: string, type: string, extra = {}) {
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    const result = await wait(m => m.type === "response" && m.id === id);
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
  }
  try {
    await request("ready", "get_state");
    const commands = await request("commands", "get_commands");
    const discovered = commands.data.commands.find((command: any) => command.source === "skill" && command.name === "skill:example");
    assert.equal(discovered?.sourceInfo.path, join(skill, "SKILL.md"));
    assert.equal(discovered?.sourceInfo.scope, "project");
    for (let i = 1; i <= 16; i++) {
      if (i === 5) await request("reload", "prompt", { message: "/probe-reload" });
      await request(`p${i}`, "prompt", { message: i === 1 ? "/skill:example" : `message ${i}` });
      await wait(() => messages.filter(m => m.type === "agent_settled").length >= i);
      await wait(() => contexts.length >= i);
      assert.equal(contexts[i - 1], i < 8 ? 0 : i < 16 ? 1 : 2, `model context at prompt ${i}`);
    }
    const response = await request("messages", "get_messages");
    const records = response.data.messages;
    const reminders = records.filter((m: any) => m.role === "custom" && m.customType === "skill-reflection.reminder.v1");
    assert.equal(reminders.length, 2, JSON.stringify(records));
    assert.match(reminders[0].content, /example/);
    assert.equal(messages.filter(m => m.type === "agent_start").length, 16);
    const forkMessages = await request("fork-list", "get_fork_messages");
    const eighth = forkMessages.data.messages[7].entryId;
    const fork = await request("fork", "fork", { entryId: eighth });
    assert.equal(fork.data.cancelled, false);
    await request("fork-prompt", "prompt", { message: "forked eighth" });
    await wait(() => messages.filter(m => m.type === "agent_settled").length >= 17);
    const forked = await request("fork-messages", "get_messages");
    assert.equal(forked.data.messages.filter((m: any) => m.role === "custom" && m.customType === "skill-reflection.reminder.v1").length, 1);
    const entries = await request("entries", "get_entries");
    const forkedUser = entries.data.entries.find((e: any) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("forked eighth"));
    await request("tree", "prompt", { message: `/probe-tree ${forkedUser.parentId}` });
    await request("tree-prompt", "prompt", { message: "new eighth" });
    await wait(() => messages.filter(m => m.type === "agent_settled").length >= 18);
    const treeMessages = await request("tree-messages", "get_messages");
    assert.equal(treeMessages.data.messages.filter((m: any) => m.role === "custom" && m.customType === "skill-reflection.reminder.v1").length, 1);
    const newSession = await request("new", "new_session");
    assert.equal(newSession.data.cancelled, false);
    for (let i = 1; i <= 8; i++) {
      await request(`fresh-${i}`, "prompt", { message: `fresh session ${i}` });
      await wait(() => messages.filter(m => m.type === "agent_settled").length >= 18 + i);
      await wait(() => contexts.length >= 18 + i);
      assert.equal(contexts[17 + i], 0);
    }
    const fresh = await request("fresh-messages", "get_messages");
    assert.equal(fresh.data.messages.filter((m: any) => m.role === "custom" && m.customType === "skill-reflection.reminder.v1").length, 0);
  } finally {
    child.stdin.end(); if (child.exitCode === null) child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(kill); lines.close(); diagnosticLines.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
