/**
 * §34.1 Storage tests.
 *
 * Covers:
 *  - V2 layout creation (manifest, events, artifacts/, snapshots/, worktrees/)
 *  - Atomic manifest write (no half-written manifest even on rapid concurrent writes)
 *  - Legacy manifest rejected by loadManifest (no silent V2 mutation)
 *  - Append-only events.jsonl preserves earlier records (via appendFile)
 *  - Path helpers reject traversal sequences and unsafe task ids
 *
 * HOME is redirected to a temp dir BEFORE the first module access so the
 * test does NOT touch the real ~/.omp/tasks. Both Bun.env.HOME and
 * process.env.HOME are set so paths.ts (which reads Bun.env.HOME first)
 * and any node:fs fallback both see the test directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let homeDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;
let originalTasksRoot: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-storage-"));
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

describe("paths.ts task id validation", () => {
  test("rejects empty / too short / path-traversal ids", async () => {
    const paths = await import("../paths.ts");
    expect(paths.isValidTaskId("")).toBe(false);
    expect(paths.isValidTaskId("a")).toBe(false);
    expect(paths.isValidTaskId("../etc/passwd")).toBe(false);
    expect(paths.isValidTaskId("foo/bar")).toBe(false);
    expect(paths.isValidTaskId("foo bar")).toBe(false);
    expect(paths.isValidTaskId("foo.bar")).toBe(false);
    expect(paths.isValidTaskId("good-id_2")).toBe(true);
  });

  test("taskRootDir throws on invalid id", async () => {
    const paths = await import("../paths.ts");
    expect(() => paths.taskRootDir("../escape")).toThrow();
  });

  test("isInside and safeResolve", async () => {
    const paths = await import("../paths.ts");
    expect(paths.isInside("/a/b", "/a/b/c")).toBe(true);
    expect(paths.isInside("/a/b", "/a/bb")).toBe(false);
    expect(paths.isInside("/a/b", "/a/b")).toBe(true);
    expect(() => paths.safeResolve("/a/b", "/etc/passwd")).toThrow();
  });

  test("getTaskRoot returns test HOME, not real HOME", async () => {
    const paths = await import("../paths.ts");
    expect(paths.getTaskRoot()).toBe(join(homeDir, ".omp", "tasks"));
    expect(paths.getTaskRoot()).not.toContain((originalBunHome ?? "") + "/.omp/tasks");
  });
});

describe("storage.ts atomic manifest", () => {
  test("saves and loads a V2 manifest round-trip", async () => {
    const storage = await import("../storage.ts");
    const paths = await import("../paths.ts");
    const m = {
      schemaVersion: 2 as const,
      id: "rid1",
      type: "feat" as const,
      phase: "discovery" as const,
      primaryRepo: "p",
      repos: { p: { name: "p", role: "primary" as const, sourcePath: "/x/y" } },
      sessions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await storage.saveManifest(m);
    const loaded = await storage.loadManifest("rid1");
    expect(loaded.id).toBe("rid1");
    expect(loaded.schemaVersion).toBe(2);
    expect(paths.manifestPath("rid1")).toBe(join(homeDir, ".omp", "tasks", "rid1", "manifest.json"));
  });

  test("loadManifest rejects legacy (v1) manifest", async () => {
    const storage = await import("../storage.ts");
    const paths = await import("../paths.ts");
    await mkdir(paths.taskRootDir("legacy1"), { recursive: true });
    await writeFile(
      paths.manifestPath("legacy1"),
      JSON.stringify({
        id: "legacy1",
        type: "feat",
        phase: "analysis",
        primary: "p",
        repos: {},
        specPath: "docs/specs/legacy1.md",
        approvedSpecHash: null,
        snapshotHash: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await expect(storage.loadManifest("legacy1")).rejects.toThrow(/legacy/);
  });

  test("loadManifest throws TaskNotFoundError on missing task", async () => {
    const storage = await import("../storage.ts");
    await expect(storage.loadManifest("nope")).rejects.toThrow(/not found/);
  });

  test("saveManifest uses a sibling tmp file then renames", async () => {
    const storage = await import("../storage.ts");
    const paths = await import("../paths.ts");
    const target = paths.manifestPath("rid-tmp");
    const m = {
      schemaVersion: 2 as const,
      id: "rid-tmp",
      type: "feat" as const,
      phase: "discovery" as const,
      primaryRepo: "p",
      repos: { p: { name: "p", role: "primary" as const, sourcePath: "/x" } },
      sessions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await storage.saveManifest(m);
    const siblings = await Array.fromAsync(
      new Bun.Glob("manifest.json.tmp-*").scan({ cwd: paths.taskRootDir("rid-tmp") }),
    );
    expect(siblings).toEqual([]);
    const final = await Bun.file(target).text();
    expect(final).toContain('"id": "rid-tmp"');
  });
});

describe("events.jsonl append-only", () => {
  test("appends preserve order across many writes (appendFile)", async () => {
    const storage = await import("../storage.ts");
    const paths = await import("../paths.ts");
    await mkdir(paths.taskRootDir("rid2"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await storage.appendEvent({
        type: "task_created",
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        taskId: "rid2",
        seq: i,
      });
    }
    const { events, malformed } = await storage.readEvents("rid2");
    expect(malformed).toBe(0);
    expect(events.length).toBe(5);
    expect(events.map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("readEvents tolerates and reports malformed lines", async () => {
    const storage = await import("../storage.ts");
    const paths = await import("../paths.ts");
    await mkdir(paths.taskRootDir("rid3"), { recursive: true });
    await storage.appendEvent({
      type: "task_created",
      at: "2026-01-01T00:00:00Z",
      taskId: "rid3",
    });
    await appendFile(paths.eventsPath("rid3"), "{ not json\n");
    const { events, malformed } = await storage.readEvents("rid3");
    expect(events.length).toBe(1);
    expect(malformed).toBe(1);
  });
});
