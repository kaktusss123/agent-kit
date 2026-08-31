import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpcAgentRuntime } from "../adapters/omp/rpc-runtime.ts";

const runtime = new OmpRpcAgentRuntime();
const ref = (sessionFile: string) => ({ kind: "omp-rpc", sessionId: "session", metadata: { sessionFile } });
const user = (text: string) => JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } });
const answer = (phase: string) => JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "answer", textSignature: JSON.stringify({ phase }) }] } });

async function session(lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tcsf-reconcile-"));
  const path = join(root, "session.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

test("reconciles repeated prompts by logical marker and content hash", async () => {
  const first = "same prompt [TCSF logical-turn id=e:1 content-hash=aaa]";
  const second = "same prompt [TCSF logical-turn id=e:2 content-hash=bbb]";
  const path = await session([user(first), answer("final_answer"), user(second)]);
  expect(await runtime.reconcileTurn(ref(path), { logicalTurnId: "e:2", prompt: second, contentHash: "bbb" })).toBe("unknown");
  expect(await runtime.reconcileTurn(ref(path), { logicalTurnId: "e:1", prompt: first, contentHash: "aaa" })).toBe("completed");
});

test("does not use an old answer, partial record, or malformed tail", async () => {
  const prompt = "prompt [TCSF logical-turn id=e:3 content-hash=ccc]";
  const path = await session([answer("final_answer"), user(prompt), '{"message":{"role":"assistant","content":[{"type":"text","text":"partial"}]', "not-json"]);
  expect(await runtime.reconcileTurn(ref(path), { logicalTurnId: "e:3", prompt, contentHash: "ccc" })).toBe("unknown");
  expect(await runtime.reconcileTurn(ref(path), { logicalTurnId: "e:4", prompt, contentHash: "ccc" })).toBe("not_accepted");
});
