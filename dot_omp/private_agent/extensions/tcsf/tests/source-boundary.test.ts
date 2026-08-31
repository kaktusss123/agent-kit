import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const productionRoots = ["app", "adapters", "bindings", "core", "ports"];
const productionFiles = ["runner.ts", "run-driver-process.ts"];
const forbidden = [
  "TCSF_TEST_",
  "TCSF_FORCE_FIRST_VERIFICATION_FAILURE",
  "TCSF_TEST_UNAUTHORIZED_WRITE_TARGETS",
  "TCSF_CANDIDATE_CHILD",
  "TCSF_STABLE_SOURCE_INDEX",
  "TCSF_STABLE_ACTIVE_INDEX",
  "unauthorized-test-write",
  "forbidden.txt",
];

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]));
  return nested.flat();
}

describe("production boundary", () => {
  test("production runtime contains no test-only mutation hooks", async () => {
    const paths = [...productionFiles.map(name => join(root, name)), ...(await Promise.all(productionRoots.map(name => files(join(root, name))))).flat()];
    const violations: string[] = [];
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      for (const marker of forbidden) if (source.includes(marker)) violations.push(`${path}: ${marker}`);
    }
    expect(violations).toEqual([]);
  });
});
