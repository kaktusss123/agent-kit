/**
 * §34.6 Permissions tests.
 *
 * Covers:
 *  - canonical path resolution + symlink/.. traversal protection
 *  - cracker edit/write target repo → deny
 *  - implementer edit/write primary worktree → allow
 *  - implementer edit/write original source → deny
 *  - implementer edit/write reference → deny
 *  - new file in worktree (does not yet exist) → allow
 *  - .. traversal attempt → deny
 *  - repo fingerprint detects tracked mutation / new untracked / HEAD move
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskManifestV2 } from "../types.ts";

let homeDir: string;
let workDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-perm-"));
  workDir = join(homeDir, "work");
  await mkdir(workDir, { recursive: true });
  originalBunHome = Bun.env.HOME;
  originalProcHome = process.env.HOME;
  Bun.env.HOME = homeDir;
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalBunHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = originalBunHome;
  if (originalProcHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalProcHome;
  await rm(homeDir, { recursive: true, force: true });
});

async function makeDir(name: string): Promise<string> {
  const d = join(workDir, name);
  await mkdir(d, { recursive: true });
  return d;
}

function canon(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  const { dirname, join, sep } = require("node:path") as typeof import("node:path");
  let cur = p;
  const tail: string[] = [];
  const d = dirname;
  const j = join;
  while (cur !== "/" && cur !== "." && cur !== d(cur)) {
    try { return realpathSync(cur) + (tail.length ? sep + tail.reverse().join(sep) : ""); } catch { /* keep climbing */ }
    tail.unshift(cur.slice(d(cur).length + 1));
    cur = d(cur);
  }
  return p;
}

function mkManifest(repos: Record<string, { role: "primary" | "target" | "reference"; sourcePath: string; worktreePath?: string }>): TaskManifestV2 {
  const reposTyped: TaskManifestV2["repos"] = {};
  for (const [n, r] of Object.entries(repos)) {
    reposTyped[n] = { name: n, role: r.role, sourcePath: r.sourcePath, ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}) };
  }
  return {
    schemaVersion: 2,
    id: "perm",
    type: "feat",
    phase: "implementing",
    primaryRepo: Object.entries(repos).find(([, r]) => r.role === "primary")?.[0] ?? "primary",
    repos: reposTyped,
    sessions: {
      cracker: { sessionFile: "/cracker", role: "cracker", createdAt: "2026-01-01T00:00:00Z" },
      implementer: { sessionFile: "/implementer", role: "implementer", createdAt: "2026-01-01T00:00:00Z" },
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("canonicalize", () => {
  test("returns realpath of existing path", async () => {
    const p = await import("../permissions.ts");
    const d = await makeDir("c1");
    await writeFile(join(d, "x.ts"), "x");
    expect(p.canonicalize(join(d, "x.ts"))).toBe(canon(join(d, "x.ts")));
  });

  test("returns null for non-existent path", async () => {
    const p = await import("../permissions.ts");
    expect(p.canonicalize("/no/such/path/at/all")).toBeNull();
  });
});

describe("canonicalizeForWrite", () => {
  test("allows NEW file inside existing worktree (does not yet exist)", async () => {
    const p = await import("../permissions.ts");
    const d = await makeDir("wt");
    const target = join(d, "new-file.ts");
    expect(await Bun.file(target).exists()).toBe(false);
    const { canonical, existsOnDisk } = p.canonicalizeForWrite(target);
    expect(canonical).toBe(canon(target));
    expect(existsOnDisk).toBe(false);
  });

  test("detects existing file", async () => {
    const p = await import("../permissions.ts");
    const d = await makeDir("wt2");
    const target = join(d, "x.ts");
    await writeFile(target, "x");
    const { canonical, existsOnDisk } = p.canonicalizeForWrite(target);
    expect(canonical).toBe(canon(target));
    expect(existsOnDisk).toBe(true);
  });

  test("collapses .. in the missing tail to a path outside the parent", async () => {
    const p = await import("../permissions.ts");
    const d = await makeDir("wt3");
    const target = join(d, "subdir", "../../escape.txt");
    const { canonical } = p.canonicalizeForWrite(target);
    expect(canonical.endsWith("/escape.txt")).toBe(true);
    expect(canonical.startsWith(d)).toBe(false);
  });
});

describe("pathContained", () => {
  test("strict prefix containment", async () => {
    const p = await import("../permissions.ts");
    expect(p.pathContained("/a/b", "/a/b/c")).toBe(true);
    expect(p.pathContained("/a/b", "/a/bb")).toBe(false);
    expect(p.pathContained("/a/b", "/a/b")).toBe(true);
  });
});

describe("cracker write policy", () => {
  test("denies write to primary source repo", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const m = mkManifest({ primary: { role: "primary", sourcePath: primary } });
    const ctx = { role: "cracker" as const, manifest: m };
    const d = p.evaluateWrite(ctx, join(primary, "foo.ts"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("cracker");
    expect(d.reason).toContain("primary");
  });

  test("allows write inside task artifacts directory", async () => {
    const p = await import("../permissions.ts");
    const paths = await import("../paths.ts");
    const primary = await makeDir("primary-src");
    await mkdir(paths.artifactsDir("perm"), { recursive: true });
    const m = mkManifest({ primary: { role: "primary", sourcePath: primary } });
    const ctx = { role: "cracker" as const, manifest: m };
    const target = paths.specPath("perm");
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(true);
    expect(d.authorizedRoot).toBe(canon(paths.artifactsDir("perm")));
  });

  test("denies write to new file inside task artifacts's forbidden path (primary src)", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const m = mkManifest({ primary: { role: "primary", sourcePath: primary } });
    const ctx = { role: "cracker" as const, manifest: m };
    const target = join(primary, "new.ts"); // file does not exist
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(false);
  });
});

describe("implementer write policy", () => {
  test("allows write to existing file in primary worktree", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt");
    const file = join(wt, "src.ts");
    await writeFile(file, "// initial");
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, file);
    expect(d.allowed).toBe(true);
    expect(d.authorizedRoot).toBe(canon(wt));
  });

  test("allows write to NEW file in primary worktree", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt-new");
    const target = join(wt, "new-file.ts");
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(true);
  });

  test("denies write to original primary source checkout", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt-deny");
    const target = join(primary, "src.ts");
    await writeFile(target, "// original");
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("original source checkout");
  });

  test("denies write to reference repo", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt-ref");
    const ref = await makeDir("ref");
    const target = join(ref, "ref.ts");
    await writeFile(target, "// ref");
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
      reference: { role: "reference", sourcePath: ref },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("reference repo");
  });

  test("denies `..` escape attempt from worktree", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt-esc");
    const escape = join(wt, "sub", "..", "..", "etc", "passwd");
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, escape);
    expect(d.allowed).toBe(false);
  });

  test("denies write through symlink pointing outside worktree", async () => {
    const p = await import("../permissions.ts");
    const primary = await makeDir("primary-src");
    const wt = await makeDir("wt-sym");
    const target = join(wt, "link", "passwd");
    // create wt/link → /etc (existing outside)
    await symlink("/etc", join(wt, "link"));
    const m = mkManifest({
      primary: { role: "primary", sourcePath: primary, worktreePath: wt },
    });
    const ctx = { role: "implementer" as const, manifest: m };
    const d = p.evaluateWrite(ctx, target);
    expect(d.allowed).toBe(false);
  });
});

describe("roleForSession", () => {
  test("returns null for unbound session", async () => {
    const p = await import("../permissions.ts");
    const m = mkManifest({ primary: { role: "primary", sourcePath: "/x" } });
    expect(p.roleForSession(m, undefined)).toBeNull();
    expect(p.roleForSession(m, "/not-bound")).toBeNull();
  });
  test("returns cracker/implementer for bound sessions", async () => {
    const p = await import("../permissions.ts");
    const m = mkManifest({ primary: { role: "primary", sourcePath: "/x" } });
    expect(p.roleForSession(m, "/cracker")).toBe("cracker");
    expect(p.roleForSession(m, "/implementer")).toBe("implementer");
  });
});

describe("RepoFingerprint", () => {
  test("detects tracked mutation", async () => {
    const p = await import("../permissions.ts");
    const a = p.fingerprintFromGitOutput("abc", "");
    const b = p.fingerprintFromGitOutput("abc", " M foo.ts\n");
    expect(p.fingerprintsEqual(a, b)).toBe(false);
  });

  test("detects new untracked file", async () => {
    const p = await import("../permissions.ts");
    const a = p.fingerprintFromGitOutput("abc", "");
    const b = p.fingerprintFromGitOutput("abc", "?? new.ts\n");
    expect(p.fingerprintsEqual(a, b)).toBe(false);
  });

  test("detects HEAD movement", async () => {
    const p = await import("../permissions.ts");
    const a = p.fingerprintFromGitOutput("abc", "");
    const b = p.fingerprintFromGitOutput("def", "");
    expect(p.fingerprintsEqual(a, b)).toBe(false);
  });

  test("equal when both empty", async () => {
    const p = await import("../permissions.ts");
    const a = p.fingerprintFromGitOutput("abc", "");
    const b = p.fingerprintFromGitOutput("abc", "");
    expect(p.fingerprintsEqual(a, b)).toBe(true);
  });
});
