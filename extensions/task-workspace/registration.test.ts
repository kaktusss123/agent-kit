/**
 * Standalone registration regression (SPEC R2/R3.2): loading the
 * task-workspace extension entry (with no subagents module involved) still
 * registers the five task tools, the intentional bash override, and the
 * tool_call mutation guard using the capture-seam style of
 * workspace-agent.test.ts.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const EXPECTED_TOOLS = [
  "bash",
  "checkpoint_commit",
  "ensure_task_repo",
  "remove_task_lane",
  "task_status",
  "teardown_task_repo",
];

interface Capture {
  tools: string[];
  toolCallHandlers: Array<(event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string }) => unknown>;
}

function loadStandalone(): Capture {
  const capture: Capture = { tools: [], toolCallHandlers: [] };
  const pi = {
    registerTool: (def: { name: string }) => {
      capture.tools.push(def.name);
    },
    on: (event: string, cb: Capture["toolCallHandlers"][number]) => {
      if (event === "tool_call") capture.toolCallHandlers.push(cb);
    },
  } as unknown as ExtensionAPI;
  // Dynamic import on purpose: the subject is the plain module load of the
  // extension entry with nothing else from the repo loaded first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require("./index.ts").default as (pi: ExtensionAPI) => void;
  factory(pi);
  return capture;
}

describe("standalone task-workspace registration", () => {
  test("registers the five task tools, bash override, and mutation guard", () => {
    const capture = loadStandalone();
    expect([...capture.tools].sort()).toEqual(EXPECTED_TOOLS);
    expect(capture.tools).toContain("bash");
    expect(capture.toolCallHandlers).toHaveLength(1);
  });

  test("the registered tool_call handler is the real mutation guard", () => {
    const capture = loadStandalone();
    // Fixture: a real git repo OUTSIDE /tmp (the guard deliberately ignores
    // temporary roots) and outside this worktree (no tree pollution); the
    // guard blocks .git metadata writes before any classification, which is
    // deterministic to trigger.
    const repo = path.join(os.homedir(), `.agent-kit-tw-registration-${process.pid}`);
    fs.mkdirSync(repo, { recursive: true });
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      const verdict = capture.toolCallHandlers[0]!(
        { toolName: "write", input: { path: path.join(repo, ".git", "config") } },
        { cwd: repo },
      ) as { block?: boolean; reason?: string } | undefined;
      expect(verdict?.block).toBe(true);
      expect(String(verdict?.reason)).toContain("Git metadata");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
