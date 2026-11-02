/**
 * Workspace directories must be usable as a Node working directory.
 *
 * The previous directory spelling escaped the identity with `%2F`, which is a
 * perfectly legal filesystem name but not a legal module path: any tool that
 * turns a file path inside the workspace into an ESM specifier dies with
 * `ERR_INVALID_MODULE_SPECIFIER: ... must not include encoded "/"`. That made
 * `node`, `vitest` and `vite build` unusable in every task worktree whose
 * branch contains `/`, i.e. almost all of them.
 *
 * This suite fixes both halves of the contract in a real child process: the
 * current (`~2F`) directory loads, the previous (`%2F`) one does not. It
 * deliberately imports only `encodeTaskWorkspaceName`, so the first assertion
 * is meaningful on its own instead of failing on an unrelated import.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { encodeTaskWorkspaceName } from "./workspace-path.ts";

let base: string | null = null;

function tempDir(prefix: string): string {
  base ??= mkdtempSync(join(tmpdir(), "ws-esm-"));
  const dir = join(base, `${prefix}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

/** Import a module by filesystem path in a child node, the way test runners,
 *  bundlers and build tools resolve a path into a module specifier. */
function importModule(modulePath: string, cwd: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import(process.argv[1]); console.log(m.marker);",
      modulePath,
    ],
    { cwd, encoding: "utf8" },
  );
}

function moduleIn(directoryName: string): string {
  const root = tempDir("esm");
  const dir = join(root, directoryName);
  mkdirSync(dir, { recursive: true });
  const mod = join(dir, "mod.mjs");
  writeFileSync(mod, 'export const marker = "loaded";\n');
  return mod;
}

describe("a workspace directory named from a slash-bearing identity", () => {
  test("imports its modules through a Node child process", () => {
    const identity = "feat/esm-check";
    const mod = moduleIn(encodeTaskWorkspaceName(identity));

    const proc = importModule(mod, join(mod, ".."));
    expect(proc.stderr).not.toContain("ERR_INVALID_MODULE_SPECIFIER");
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe("loaded");
  });

  test("the previous percent spelling is exactly what the loader rejects", () => {
    // Written out literally: this is the directory name the deployed `%`
    // encoding produced for `feat/esm-check`, and the whole reason the current
    // marker is `~` (invalid in a Git ref, so it needs no escaping) rather
    // than a percent escape (legal in a ref, illegal in a module path).
    const mod = moduleIn("feat%2Fesm-check");

    const proc = importModule(mod, join(mod, ".."));
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("ERR_INVALID_MODULE_SPECIFIER");
    expect(proc.stderr).toContain('must not include encoded "/"');
  });
});
