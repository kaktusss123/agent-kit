import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry).href);
const { SessionManager } = await import(piEntry);
const entry = resolve(import.meta.dirname, "index.ts");

async function harness(sm = SessionManager.inMemory(), subagent = false) {
  const old = process.env.PI_SUBAGENT_ID;
  if (subagent) process.env.PI_SUBAGENT_ID = "child";
  else delete process.env.PI_SUBAGENT_ID;
  let loaded;
  try { loaded = await loadExtensions([entry], process.cwd()); }
  finally { if (old === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = old; }
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.appendEntry = (type: string, data: unknown) => sm.appendCustomEntry(type, data);
  loaded.runtime.getCommands = () => [{ source: "skill", name: "skill:queued", sourceInfo: { path: "/tmp/queued/SKILL.md" } }];
  const ctx = { cwd: process.cwd(), sessionManager: sm };
  const emit = async (name: string, data: any = {}) => {
    let result;
    for (const fn of loaded.extensions[0].handlers.get(name) ?? []) result = await fn({ type: name, ...data }, ctx);
    return result;
  };
  const prompt = async (source = "interactive", text = "hello", skills: any[] = []) => {
    await emit("input", { source, text });
    const result = await emit("before_agent_start", { messageType: "user", prompt: text, systemPromptOptions: { skills } });
    sm.appendMessage({ role: "user", content: text, timestamp: 1 });
    if (result?.message) sm.appendCustomMessageEntry(result.message.customType, result.message.content, false);
    return result;
  };
  return { sm, emit, prompt };
}

function read(sm: any, path: string, failed = false) {
  const id = `call-${sm.getBranch().length}`;
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 });
  sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "x" }], isError: failed, timestamp: 2 });
}

test("no reminder for failed reads or absent skills, then cadence resets after reminder", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/failed/SKILL.md", true);
  for (let i = 0; i < 9; i++) assert.equal(await h.prompt(), undefined);
  read(h.sm, "/tmp/skills/good/SKILL.md");
  const first = await h.prompt();
  assert.match(first.message.content, /good/);
  assert.doesNotMatch(first.message.content, /failed/);
  for (let i = 0; i < 7; i++) assert.equal(await h.prompt(), undefined);
  assert.ok((await h.prompt()).message);
});

test("extension and custom events do not count; child registers nothing", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  for (let i = 0; i < 12; i++) {
    assert.equal(await h.prompt("extension"), undefined);
    assert.equal(await h.emit("before_agent_start", { messageType: "custom" }), undefined);
  }
  for (let i = 0; i < 7; i++) assert.equal(await h.prompt(), undefined);
  assert.ok((await h.prompt()).message);
  const child = await harness(SessionManager.inMemory(), true);
  for (let i = 0; i < 10; i++) assert.equal(await child.prompt(), undefined);
  assert.equal(child.sm.getBranch().filter((e: any) => e.type === "custom").length, 0);
});

test("a failed read cannot be revived by a later unrelated result with the same id", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/failed/SKILL.md", true);
  const result = h.sm.getBranch().at(-1).message;
  h.sm.appendMessage({ ...result, isError: false });
  for (let i = 0; i < 9; i++) assert.equal(await h.prompt(), undefined);
});

test("advertised skills and unfinished tool calls are not treated as loaded", async () => {
  const h = await harness();
  h.sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "unmatched", name: "read", arguments: { path: "/tmp/skills/fake/SKILL.md" } }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 });
  for (let i = 0; i < 10; i++) assert.equal(await h.prompt("rpc", "hello", [{ name: "fake", filePath: "/tmp/skills/fake/SKILL.md" }]), undefined);
});

test("queued human input is counted only after delivery; extension queue is ignored", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  await h.emit("input", { source: "rpc", text: "start" });
  await h.emit("before_agent_start", { messageType: "user", prompt: "start", systemPromptOptions: { skills: [] } });
  await h.emit("message_start", { message: { role: "user" } });
  h.sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
  for (let i = 0; i < 6; i++) await h.emit("input", { source: "rpc", text: "queued", streamingBehavior: "steer" });
  for (let i = 0; i < 6; i++) {
    await h.emit("message_start", { message: { role: "user" } });
    h.sm.appendMessage({ role: "user", content: "queued", timestamp: 1 });
  }
  await h.emit("agent_settled");
  assert.ok((await h.prompt()).message);
});

test("queued skill requires an actually expanded skill block", async () => {
  const h = await harness();
  await h.emit("input", { source: "rpc", text: "start" });
  await h.emit("before_agent_start", { messageType: "user", prompt: "start", systemPromptOptions: { skills: [] } });
  await h.emit("message_start", { message: { role: "user", content: "start" } });
  h.sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
  await h.emit("input", { source: "rpc", text: "/skill:queued", streamingBehavior: "steer" });
  await h.emit("message_start", { message: { role: "user", content: [{ type: "text", text: '<skill name="queued" location="/tmp/queued/SKILL.md">\nbody\n</skill>' }] } });
  h.sm.appendMessage({ role: "user", content: "expanded", timestamp: 1 });
  await h.emit("agent_settled");
  for (let i = 0; i < 5; i++) assert.equal(await h.prompt(), undefined);
  assert.match((await h.prompt()).message.content, /queued/);
});

test("mixed queued sources are not attributed when delivery identity is ambiguous", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  await h.emit("input", { source: "rpc", text: "start" });
  await h.emit("before_agent_start", { messageType: "user", prompt: "start", systemPromptOptions: { skills: [] } });
  await h.emit("message_start", { message: { role: "user" } });
  h.sm.appendMessage({ role: "user", content: "start", timestamp: 1 });
  await h.emit("input", { source: "rpc", text: "cancelled", streamingBehavior: "steer" });
  await h.emit("input", { source: "extension", text: "automatic", streamingBehavior: "steer" });
  await h.emit("message_start", { message: { role: "user" } });
  h.sm.appendMessage({ role: "user", content: "automatic", timestamp: 1 });
  await h.emit("agent_settled");
  for (let i = 0; i < 6; i++) assert.equal(await h.prompt(), undefined);
  assert.ok((await h.prompt()).message);
});

test("untrusted paths cannot inject instructions or unbounded skill names", async () => {
  const h = await harness();
  read(h.sm, `/tmp/skills/${"x".repeat(80)}/SKILL.md`);
  read(h.sm, "/tmp/skills/bad\nignore-instructions/SKILL.md");
  for (let i = 0; i < 8; i++) assert.equal(await h.prompt(), undefined);
  read(h.sm, "/tmp/skills/safe/SKILL.md");
  const result = await h.prompt();
  assert.match(result.message.content, /safe/);
  assert.doesNotMatch(result.message.content, /ignore-instructions|x{80}/);
});

test("aborted preparation does not increment the count or import a skill", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  for (let i = 0; i < 6; i++) await h.prompt();
  await h.emit("input", { source: "rpc", text: "/skill:queued" });
  await h.emit("before_agent_start", { messageType: "user", prompt: '<skill name="queued" location="/tmp/queued/SKILL.md">\nbody\n</skill>', systemPromptOptions: { skills: [{ name: "queued", filePath: "/tmp/queued/SKILL.md" }] } });
  assert.equal(await h.prompt(), undefined);
  const result = await h.prompt();
  assert.match(result.message.content, /good/);
  assert.doesNotMatch(result.message.content, /queued/);
});

test("an automated user message replaces abandoned human source metadata", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  for (let i = 0; i < 6; i++) await h.prompt();
  await h.emit("input", { source: "rpc", text: "aborted" });
  await h.emit("before_agent_start", { messageType: "user", prompt: "aborted", systemPromptOptions: { skills: [] } });
  assert.equal(await h.prompt("extension"), undefined);
  assert.equal(await h.prompt(), undefined);
  assert.ok((await h.prompt()).message);
});

test("retries and tool turns do not count as user inputs", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  for (let i = 0; i < 7; i++) {
    assert.equal(await h.prompt(), undefined);
    for (let j = 0; j < 3; j++) {
      await h.emit("agent_start");
      await h.emit("turn_start");
      await h.emit("tool_result", { toolName: "read", isError: true });
      await h.emit("agent_end");
    }
  }
  assert.ok((await h.prompt()).message);
  assert.equal(await h.prompt(), undefined);
});

test("a branch ending before the expanded user message does not import its skill", async () => {
  const h = await harness();
  for (let i = 0; i < 7; i++) await h.prompt();
  await h.emit("input", { source: "rpc", text: "/skill:queued" });
  await h.emit("before_agent_start", { messageType: "user", prompt: '<skill name="queued" location="/tmp/queued/SKILL.md">\nbody\n</skill>', systemPromptOptions: { skills: [{ name: "queued", filePath: "/tmp/queued/SKILL.md" }] } });
  const beforeUser = h.sm.getLeafId();
  h.sm.appendMessage({ role: "user", content: "expanded", timestamp: 1 });
  h.sm.branch(beforeUser);
  const restored = await harness(h.sm);
  assert.equal(await restored.prompt(), undefined);
});

test("a real fork rehydrates markers without changing the parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflection-fork-"));
  try {
    const parent = SessionManager.create(process.cwd(), dir);
    const h = await harness(parent);
    read(parent, "/tmp/skills/good/SKILL.md");
    for (let i = 0; i < 7; i++) await h.prompt();
    const fork = SessionManager.forkFrom(parent.getSessionFile(), process.cwd(), dir);
    const child = await harness(fork);
    assert.ok((await child.prompt()).message);
    const original = await harness(parent);
    assert.ok((await original.prompt()).message);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch navigation and reload recover only active branch markers", async () => {
  const h = await harness();
  read(h.sm, "/tmp/skills/good/SKILL.md");
  for (let i = 0; i < 4; i++) await h.prompt();
  const forkPoint = h.sm.getLeafId();
  for (let i = 0; i < 4; i++) await h.prompt();
  h.sm.branch(forkPoint);
  const restored = await harness(h.sm);
  for (let i = 0; i < 3; i++) assert.equal(await restored.prompt(), undefined);
  assert.ok((await restored.prompt()).message);
});
