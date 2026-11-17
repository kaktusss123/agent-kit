import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry).href);
const { SessionManager } = await import(piEntry);
const entry = resolve(import.meta.dirname, "index.ts");

test("real Pi loader and SessionManager count eight real prompts after a successful skill read", async () => {
  const previous = process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ID;
  const loaded = await loadExtensions([entry], process.cwd());
  if (previous !== undefined) process.env.PI_SUBAGENT_ID = previous;
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const sm = SessionManager.inMemory();
  loaded.runtime.appendEntry = (type: string, data: unknown) => sm.appendCustomEntry(type, data);
  const ctx = { cwd: process.cwd(), sessionManager: sm };
  const emit = async (name: string, data: any) => {
    let result;
    for (const fn of ext.handlers.get(name) ?? []) result = await fn({ type: name, ...data }, ctx);
    return result;
  };
  await emit("session_start", {});
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "/tmp/skills/example/SKILL.md" } }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 });
  sm.appendMessage({ role: "toolResult", toolCallId: "read1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 });
  for (let i = 1; i <= 8; i++) {
    await emit("input", { source: "interactive", text: `message ${i}` });
    const result = await emit("before_agent_start", { messageType: "user", prompt: `message ${i}`, systemPromptOptions: { skills: [] } });
    if (i < 8) assert.equal(result, undefined);
    else { assert.ok(result, JSON.stringify(sm.getBranch())); assert.match(result.message.content, /example/); }
    sm.appendMessage({ role: "user", content: `message ${i}`, timestamp: i });
  }
});
