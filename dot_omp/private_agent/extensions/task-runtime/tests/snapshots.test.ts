/**
 * §34.5 Approval snapshot tests.
 *
 * Covers:
 *  - approval copies all four artifacts
 *  - snapshot hashes match snapshot content
 *  - later mutation of mutable artifact does NOT change the frozen snapshot
 *  - handoff.json is the only path the implementer should read from
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let homeDir: string;
let originalBunHome: string | undefined;
let originalProcHome: string | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tr-snap-"));
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

async function seedTask(taskId: string): Promise<void> {
  const paths = await import("../paths.ts");
  await mkdir(paths.artifactsDir(taskId), { recursive: true });
  await writeFile(paths.specPath(taskId), "# Spec\n\nbody");
  await writeFile(paths.evidencePath(taskId), "## Evidence\n\n- fact: 1");
  await writeFile(paths.decisionsPath(taskId), JSON.stringify({ op: "open", id: "D1", question: "q", dependsOn: [], options: ["a"], at: "2026-01-01T00:00:00Z" }) + "\n");
  await writeFile(paths.verificationPath(taskId), JSON.stringify({
    checks: [{ id: "t", repo: "primary", command: "true", required: true }],
  }));
}

describe("buildSnapshot", () => {
  test("copies all four artifacts and records hashes", async () => {
    const paths = await import("../paths.ts");
    const s = await import("../snapshots.ts");
    await seedTask("snap1");
    const approvalId = "apr-test-001";
    const { record } = await s.buildSnapshot("snap1", approvalId);
    expect(record.specSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.decisionsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.verificationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(paths.snapshotSpecPath("snap1", approvalId)).exists()).toBe(true);
    expect(await Bun.file(paths.snapshotEvidencePath("snap1", approvalId)).exists()).toBe(true);
    expect(await Bun.file(paths.snapshotDecisionsPath("snap1", approvalId)).exists()).toBe(true);
    expect(await Bun.file(paths.snapshotVerificationPath("snap1", approvalId)).exists()).toBe(true);
  });

  test("refuses to snapshot when an artifact is missing", async () => {
    const s = await import("../snapshots.ts");
    await mkdir(join(homeDir, ".omp", "tasks", "snap2", "artifacts"), { recursive: true });
    await writeFile(join(homeDir, ".omp", "tasks", "snap2", "artifacts", "spec.md"), "x");
    // evidence/decisions/verification missing
    await expect(s.buildSnapshot("snap2", "apr-x")).rejects.toThrow(/missing/);
  });

  test("snapshot content matches recorded hash (validateSnapshot)", async () => {
    const s = await import("../snapshots.ts");
    await seedTask("snap3");
    const { record } = await s.buildSnapshot("snap3", "apr-validate");
    const v = await s.validateSnapshot("snap3", record);
    expect(v.valid).toBe(true);
    expect(v.mismatches).toEqual([]);
  });

  test("later mutation of mutable artifacts does NOT change the frozen snapshot", async () => {
    const paths = await import("../paths.ts");
    const s = await import("../snapshots.ts");
    await seedTask("snap4");
    const { record } = await s.buildSnapshot("snap4", "apr-immutable");
    // Mutate the mutable artifact AFTER snapshotting.
    await writeFile(paths.specPath("snap4"), "# Spec\n\nbody TAMPERED");
    // Frozen snapshot hash unchanged.
    const v = await s.validateSnapshot("snap4", record);
    expect(v.valid).toBe(true);
    // Snapshot file content unchanged.
    const snapSpec = await readFile(paths.snapshotSpecPath("snap4", "apr-immutable"), "utf8");
    expect(snapSpec).toBe("# Spec\n\nbody");
  });
});

describe("newApprovalId", () => {
  test("produces sortable unique ids", async () => {
    const s = await import("../snapshots.ts");
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(s.newApprovalId());
    expect(ids.size).toBe(50);
  });
});

describe("writeHandoff / readHandoff", () => {
  test("writes and reads handoff.json verbatim", async () => {
    const paths = await import("../paths.ts");
    const s = await import("../snapshots.ts");
    await seedTask("snap-h");
    const { record } = await s.buildSnapshot("snap-h", "apr-handoff");
    await s.writeHandoff("snap-h", "apr-handoff", {
      taskId: "snap-h",
      type: "feat",
      approvalId: "apr-handoff",
      snapshot: {
        specPath: paths.snapshotSpecPath("snap-h", "apr-handoff"),
        evidencePath: paths.snapshotEvidencePath("snap-h", "apr-handoff"),
        decisionsPath: paths.snapshotDecisionsPath("snap-h", "apr-handoff"),
        verificationPath: paths.snapshotVerificationPath("snap-h", "apr-handoff"),
      },
      repos: {},
    });
    const doc = await s.readHandoff("snap-h", "apr-handoff");
    expect(doc.schemaVersion).toBe(1);
    expect(doc.taskId).toBe("snap-h");
    expect(doc.approvalId).toBe("apr-handoff");
  });

  test("readHandoff rejects wrong schema version", async () => {
    const paths = await import("../paths.ts");
    const s = await import("../snapshots.ts");
    await seedTask("snap-h2");
    const { record } = await s.buildSnapshot("snap-h2", "apr-h2");
    const p = paths.snapshotHandoffPath("snap-h2", "apr-h2");
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, JSON.stringify({ schemaVersion: 999, taskId: "snap-h2", approvalId: "apr-h2" }));
    await expect(s.readHandoff("snap-h2", "apr-h2")).rejects.toThrow(/schemaVersion/);
  });
});
/**
 * §27 Fix 1 — handoff snapshot paths must include approval-id.
 */
/**
 * §27 Fix 1 — handoff snapshot paths must include approval-id.
 */
describe("buildHandoff — approval-id in paths", () => {
  test("handoff snaphot paths include approval-id subdirectory", async () => {
    const paths = await import("../paths.ts");
    const lifecycle = await import("../lifecycle.ts");
    const s = await import("../snapshots.ts");
    const storage = await import("../storage.ts");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const tid = "snap-paths";
    // Seed a real manifest so lifecycle functions work
    await mkdir(paths.taskRootDir(tid), { recursive: true });
    const manifest = {
      schemaVersion: 2 as const,
      id: tid,
      type: "feat" as const,
      primaryRepo: "primary",
      phase: "ready_for_approval" as const,
      repos: { primary: { name: "primary", role: "primary" as const, sourcePath: "/tmp/fake-primary" } },
      sessions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.saveManifest(manifest);
    // Seed artifacts
    await mkdir(paths.artifactsDir(tid), { recursive: true });
    await writeFile(paths.specPath(tid), "# Spec\n\nbody");
    await writeFile(paths.evidencePath(tid), "## Evidence");
    await writeFile(paths.decisionsPath(tid), JSON.stringify({ op: "open", id: "D1", question: "q", dependsOn: [], options: ["a"], at: "2026-01-01T00:00:00Z" }) + "\n");
    await writeFile(paths.verificationPath(tid), JSON.stringify({ checks: [{ id: "t", repo: "primary", command: "true", required: true }] }));
    // Build snapshot (writes approval to manifest)
    const { record } = await s.buildSnapshot(tid, "apr-paths");
    const m = await storage.loadManifest(tid);
    m.approval = { id: "apr-paths", createdAt: record.createdAt, snapshotPath: record.snapshotPath, specSha256: record.specSha256, evidenceSha256: record.evidenceSha256, decisionsSha256: record.decisionsSha256, verificationSha256: record.verificationSha256 };
    await storage.saveManifest(m);
    // buildHandoff
    const doc = await lifecycle.buildHandoff({ taskId: tid, approvalId: "apr-paths" });
    const expectedDir = paths.snapshotDir(tid, "apr-paths");
    expect(expectedDir.endsWith("apr-paths")).toBe(true);
    expect(doc.snapshot.specPath).toBe(paths.snapshotSpecPath(tid, "apr-paths"));
    expect(doc.snapshot.evidencePath).toBe(paths.snapshotEvidencePath(tid, "apr-paths"));
    expect(doc.snapshot.decisionsPath).toBe(paths.snapshotDecisionsPath(tid, "apr-paths"));
    expect(doc.snapshot.verificationPath).toBe(paths.snapshotVerificationPath(tid, "apr-paths"));
    const { existsSync } = await import("node:fs");
    expect(existsSync(doc.snapshot.specPath)).toBe(true);
    expect(existsSync(doc.snapshot.evidencePath)).toBe(true);
    expect(existsSync(doc.snapshot.decisionsPath)).toBe(true);
    expect(existsSync(doc.snapshot.verificationPath)).toBe(true);
  });
});
