/**
 * Dependency-boundary regression: the task-workspace
 * extension must have ZERO knowledge of the subagents controller — no
 * imports/requires of ../subagents/*, no mentions in active sources or the
 * README. The allowed direction is subagents -> task-workspace, never the
 * reverse. A single focused test, not a grep framework: it fails if anyone
 * reintroduces the inverted dependency (e.g. the removed
 * require("../subagents/readiness") readiness signaling).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
const DIR = import.meta.dirname;

/** Implementation sources plus the README — everything a consumer reads. */
const ACTIVE_SOURCES = [
  "index.ts",
  "flows.ts",
  "git.ts",
  "guard.ts",
  "owner-lock.ts",
  "workspace-path.ts",
  "shim-path.ts",
  "task-root.ts",
  "types.ts",
  "shim/classify.mjs",
  "shim/policy.mjs",
  "README.md",
];

describe("task-workspace dependency boundary", () => {
  test("no active source references the subagents controller", () => {
    const violations: string[] = [];
    for (const file of ACTIVE_SOURCES) {
      const src = readFileSync(join(DIR, file), "utf8");
      if (src.includes("subagents")) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
