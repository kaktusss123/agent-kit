import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManifest, MANIFEST_HASH_ALGORITHM, validateManifest } from "../conformance/manifest.ts";

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "z.txt"), "z");
  await writeFile(join(root, "nested", "a.txt"), "a");
  return root;
}

describe("canonical evidence manifest", () => {
  test("uses the versioned length-prefixed algorithm and stable ordering", async () => {
    const first = await fixture("tcsf-manifest-order-");
    const second = await fixture("tcsf-manifest-order-");
    const one = await createManifest(first);
    const two = await createManifest(second);
    expect(one.algorithm).toBe(MANIFEST_HASH_ALGORITHM);
    expect(one.files.map(file => file.path)).toEqual(["nested/a.txt", "z.txt"]);
    expect(one.treeHash).toBe(two.treeHash);
  });

  test("changes hash for bytes and paths", async () => {
    const root = await fixture("tcsf-manifest-change-");
    const original = await createManifest(root);
    await writeFile(join(root, "z.txt"), "changed");
    const changedBytes = await createManifest(root);
    expect(changedBytes.treeHash).not.toBe(original.treeHash);
    await writeFile(join(root, "renamed.txt"), "changed");
    const changedPath = await createManifest(root);
    expect(changedPath.treeHash).not.toBe(changedBytes.treeHash);
  });

  test("rejects extra, missing, and altered files", async () => {
    const root = await fixture("tcsf-manifest-integrity-");
    const manifest = await createManifest(root);
    await writeFile(join(root, "extra.txt"), "extra");
    expect((await validateManifest(root, manifest)).some(error => error.includes("extra file"))).toBe(true);
    const extraRoot = await fixture("tcsf-manifest-integrity-");
    const extraManifest = await createManifest(extraRoot);
    await writeFile(join(extraRoot, "nested", "a.txt"), "altered");
    expect((await validateManifest(extraRoot, extraManifest)).some(error => error.includes("file hash mismatch"))).toBe(true);
    const missingRoot = await fixture("tcsf-manifest-integrity-");
    const missingManifest = await createManifest(missingRoot);
    await Bun.write(join(missingRoot, "z.txt"), "");
    await (await import("node:fs/promises")).rm(join(missingRoot, "z.txt"));
    expect((await validateManifest(missingRoot, missingManifest)).some(error => error.includes("missing file"))).toBe(true);
  });

  test("rejects symlinks and validates relocated copies", async () => {
    const root = await fixture("tcsf-manifest-symlink-");
    await symlink(join(root, "z.txt"), join(root, "link.txt"));
    await expect(createManifest(root)).rejects.toThrow("manifest rejects symlink");
    const clean = await fixture("tcsf-manifest-relocate-");
    const manifest = await createManifest(clean);
    const relocated = await fixture("tcsf-manifest-relocate-");
    expect(await validateManifest(relocated, manifest)).toEqual([]);
  });
});
