/**
 * bootstrap tests: dependency provisioning for manifest-free extension
 * worktrees. Discovery order (override env → primary node_modules →
 * walk-start ancestors → PATH → legacy root), idempotent provisioning
 * (a second run keeps correct links), and fail-safe behavior:
 * not_applicable for repos with their own manifest or no extensions/,
 * skipped without a discoverable source, real (non-symlink) entries never
 * clobbered, dangling links re-pointed.
 *
 * All fixtures use synthetic package names — no dependence on any real
 * machine installation.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import { bootstrapWorktreeDependencies, discoverDependencySource, type BootstrapConfig } from "./bootstrap.ts";

const ANCHOR = "test-anchor";
const CONFIG: BootstrapConfig = {
  packages: [ANCHOR, "test-dep", "@scope/test-dep"],
  overrideEnv: "TEST_ANCHOR_ROOT",
  legacyRoot: "",
  cliName: "test-anchor-cli",
};

let rootDir: string | null = null;

function tempDir(prefix: string): string {
  rootDir ??= mkdtempSync(join(tmpdir(), "bootstrap-"));
  const dir = join(rootDir, prefix + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

function writePackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

/** An installation root: the anchor package itself plus its dependencies
 *  in its own node_modules (npm/bun global layout shape). */
function makeInstallRoot(prefix: string): string {
  const root = tempDir(prefix);
  writePackage(join(root, "node_modules", "test-dep"), "test-dep");
  writePackage(join(root, "node_modules", "@scope", "test-dep"), "@scope/test-dep");
  writePackage(root, ANCHOR);
  return root;
}

function makeWorktree(prefix: string): string {
  const wt = tempDir(prefix);
  mkdirSync(join(wt, "extensions", "some-ext"), { recursive: true });
  return wt;
}

const EMPTY_ENV = {};

describe("discoverDependencySource", () => {
  test("returns null when nothing is discoverable", () => {
    expect(
      discoverDependencySource(CONFIG, {
        env: EMPTY_ENV,
        walkStarts: [],
        pathEnv: "",
      }),
    ).toBeNull();
  });

  test("the override env var wins with the anchor package directory", () => {
    const install = makeInstallRoot("override");
    const primary = tempDir("override-primary");
    writePackage(join(primary, "node_modules", ANCHOR), ANCHOR);
    const found = discoverDependencySource(CONFIG, {
      env: { [CONFIG.overrideEnv]: install },
      primaryDir: primary,
      walkStarts: [],
      pathEnv: "",
    });
    expect(found).toEqual({ kind: "install_root", root: install });
  });

  test("a complete primary node_modules is trusted; a partial one is not", () => {
    const primary = tempDir("primary");
    writePackage(join(primary, "node_modules", ANCHOR), ANCHOR);
    writePackage(join(primary, "node_modules", "test-dep"), "test-dep");
    writePackage(join(primary, "node_modules", "@scope", "test-dep"), "@scope/test-dep");
    expect(
      discoverDependencySource(CONFIG, { env: EMPTY_ENV, primaryDir: primary, walkStarts: [], pathEnv: "" }),
    ).toEqual({ kind: "node_modules", dir: join(primary, "node_modules") });

    // Missing one package: not a trusted source.
    rmSync(join(primary, "node_modules", "@scope"), { recursive: true, force: true });
    expect(
      discoverDependencySource(CONFIG, { env: EMPTY_ENV, primaryDir: primary, walkStarts: [], pathEnv: "" }),
    ).toBeNull();
  });

  test("walk-start ancestors locate an installed anchor package", () => {
    // npm-global shape: <prefix>/lib/node_modules/<anchor> with the anchor's
    // dependencies nested inside its own node_modules.
    const prefix = tempDir("walk");
    const anchorRoot = join(prefix, "lib", "node_modules", ANCHOR);
    writePackage(join(anchorRoot, "node_modules", "test-dep"), "test-dep");
    writePackage(join(anchorRoot, "node_modules", "@scope", "test-dep"), "@scope/test-dep");
    writePackage(anchorRoot, ANCHOR);
    const nested = join(anchorRoot, "dist", "bin");
    mkdirSync(nested, { recursive: true });
    const found = discoverDependencySource(CONFIG, { env: EMPTY_ENV, walkStarts: [nested], pathEnv: "" });
    expect(found).toEqual({ kind: "install_root", root: anchorRoot });
  });

  test("a CLI on PATH is walked up to its package root", () => {
    const install = makeInstallRoot("path");
    const bin = join(install, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, CONFIG.cliName), "#!/bin/sh\n");
    const found = discoverDependencySource(CONFIG, { env: EMPTY_ENV, walkStarts: [], pathEnv: bin });
    expect(found).toEqual({ kind: "install_root", root: install });
  });
});

describe("bootstrapWorktreeDependencies", () => {
  test("not_applicable: repository with a root package.json or no extensions/", async () => {
    const withManifest = tempDir("na-manifest");
    writeFileSync(join(withManifest, "package.json"), "{}");
    const r1 = await bootstrapWorktreeDependencies(withManifest, CONFIG, { env: EMPTY_ENV });
    expect(r1.status).toBe("not_applicable");

    const noExtensions = tempDir("na-extensions");
    const r2 = await bootstrapWorktreeDependencies(noExtensions, CONFIG, { env: EMPTY_ENV });
    expect(r2.status).toBe("not_applicable");
  });

  test("skipped with an actionable reason when no source is discoverable", async () => {
    const wt = makeWorktree("skipped");
    const r = await bootstrapWorktreeDependencies(wt, CONFIG, {
      env: { [CONFIG.overrideEnv]: join(tempDir("nope"), "missing") },
      primaryDir: null,
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain(CONFIG.overrideEnv);
  });

  test("provisions links from the override source; a rerun is a no-op (kept)", async () => {
    const install = makeInstallRoot("provision");
    const wt = makeWorktree("provision-wt");

    const first = await bootstrapWorktreeDependencies(wt, CONFIG, {
      env: { [CONFIG.overrideEnv]: install },
    });
    expect(first.status).toBe("provisioned");
    expect(first.links.map((l) => l.action)).toEqual(["created", "created", "created"]);
    for (const link of first.links) {
      expect(lstatSync(link.target).isSymbolicLink()).toBe(true);
      expect(realpathSync(link.target)).toBe(realpathSync(link.source));
    }

    const second = await bootstrapWorktreeDependencies(wt, CONFIG, {
      env: { [CONFIG.overrideEnv]: install },
    });
    expect(second.status).toBe("current");
    expect(second.links.map((l) => l.action)).toEqual(["kept", "kept", "kept"]);
  });

  test("a dangling link is re-pointed; a real directory is never clobbered", async () => {
    const install = makeInstallRoot("repair");
    const wt = makeWorktree("repair-wt");
    const target = join(wt, "node_modules", ANCHOR);
    mkdirSync(join(wt, "node_modules"), { recursive: true });

    symlinkSync(join(wt, "node_modules", "gone-away"), target);
    const real = join(wt, "node_modules", "test-dep");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "user-content.txt"), "do not touch\n");

    const r = await bootstrapWorktreeDependencies(wt, CONFIG, {
      env: { [CONFIG.overrideEnv]: install },
    });

    expect(r.status).toBe("skipped");
    expect(r.links.find((l) => l.name === ANCHOR)?.action).toBe("repointed");
    expect(realpathSync(target)).toBe(realpathSync(join(install)));
    expect(existsSync(join(real, "user-content.txt"))).toBe(true);
    expect(r.links.find((l) => l.name === "test-dep")?.action).toBe("conflict");
  });
});
