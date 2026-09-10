import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const CORE_DIR = join(import.meta.dir, "..", "extensions", "task-workspace");

describe("task-workspace core host independence", () => {
  test("core modules import and run without any host context", async () => {
    // Dynamic import is intentional (module-loading boundary exception): the
    // subject under test IS the bare-context load of the core — each module
    // must import and run with no fake pi, no OMP SDK, no extension plumbing.
    const gitCore = await import("../extensions/task-workspace/git");
    const guardCore = await import("../extensions/task-workspace/guard");
    const flowsCore = await import("../extensions/task-workspace/flows");

    expect(typeof gitCore.classifyPath).toBe("function");
    expect(typeof gitCore.scanTaskWorkspaces).toBe("function");
    expect(typeof guardCore.parseGitInvocations).toBe("function");
    expect(typeof guardCore.guardManagedWriteTarget).toBe("function");
    expect(typeof flowsCore.ensureTaskRepo).toBe("function");
    expect(typeof flowsCore.checkpointCommit).toBe("function");

    // Pure classification works with no host wiring at all.
    expect(guardCore.parseGitInvocations("git status")[0]?.mutating).toBe(false);
    expect(guardCore.parseGitInvocations("git push origin main")[0]?.operationClass).toBe(
      "external-side-effect",
    );
    expect(guardCore.parseGitInvocations("git add -A")[0]?.mutating).toBe(true);
  });

  test("core sources never reference the OMP/Pi SDK or host plumbing", () => {
    for (const file of readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(CORE_DIR, file), "utf8");
      expect(
        src.includes("@oh-my-pi") || src.includes("pi-coding-agent"),
        `${file} must not import the OMP/Pi SDK`,
      ).toBe(false);
      expect(
        /\bExtensionAPI\b|\bExtensionContext\b|registerTool|typebox|\bpi\.on\b|\bctx\.cwd\b/.test(src),
        `${file} must not reference host extension plumbing`,
      ).toBe(false);
    }
  });
});
