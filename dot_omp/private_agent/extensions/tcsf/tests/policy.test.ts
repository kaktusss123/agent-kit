import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerTcsf from "../index.ts";

test("write policy rejects traversal and symlink escapes before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tcsf-policy-")); const outside = await mkdtemp(join(tmpdir(), "tcsf-policy-outside-"));
  try {
    await writeFile(join(outside, "secret"), "secret"); await symlink(outside, join(root, "link")); let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    const schema = () => ({ optional: schema }); const pi = { zod: { object: schema, string: schema, array: schema, enum: schema }, registerCommand() {}, registerTool() {}, on(event: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) { if (event === "tool_call") handler = callback; }, logger: { info() {}, warn() {} } };
    registerTcsf(pi as never); expect(handler).toBeFunction();
    const context = { cwd: root }; expect(await handler!({ toolName: "edit", input: { path: "allowed.txt" } }, context)).toBeUndefined(); expect(await handler!({ toolName: "write", input: { path: "../secret" } }, context)).toMatchObject({ block: true }); expect(await handler!({ toolName: "write", input: { path: "link/secret" } }, context)).toMatchObject({ block: true });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
