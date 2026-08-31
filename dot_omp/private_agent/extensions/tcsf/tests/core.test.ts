import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsArtifactStore } from "../adapters/fs-artifact-store.ts";
import { defaultRunCounters, canRetry, incrementRetry } from "../core/policy.ts";
import { validateDecisionRequest } from "../core/decisions.ts";
import { canTransitionTask, transitionTask } from "../core/state.ts";
import type { ApprovedContractPacket, DecisionRequest, TcsfRun, TcsfTask } from "../core/types.ts";

describe("TCSF core", () => {
  test("allows only explicit task transitions", () => {
    expect(canTransitionTask("approved", "preparing")).toBe(true);
    expect(canTransitionTask("approved", "completed")).toBe(false);
    const task = { id: "t", revision: 0, phase: "approved", contract: {} } as TcsfTask;
    expect(transitionTask(task, "preparing").revision).toBe(1);
    expect(() => transitionTask(task, "completed")).toThrow();
  });
  test("persists atomic revisions and rejects stale writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-core-"));
    try {
      const store = new FsArtifactStore(root); const task = { id: "task", revision: 0, phase: "approved", contract: {} } as TcsfTask;
      await store.createTask({ task }); const next = { ...task, revision: 1 }; await store.saveTask(next, 0); await expect(store.saveTask({ ...next, revision: 2 }, 0)).rejects.toThrow("revision conflict");
      await store.writeArtifact("task", "contract/spec.md", new TextEncoder().encode("spec")); await expect(store.writeArtifact("task", "../escape", new Uint8Array())).rejects.toThrow();
      expect(await readFile(join(root, "tasks", "task", "task.json"), "utf8")).toContain('"revision": 1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("reloads durable run state and rejects stale run writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-run-cas-"));
    try {
      const first = new FsArtifactStore(root); const second = new FsArtifactStore(root); const task = { id: "task", revision: 0, phase: "approved", contract: {} } as TcsfTask; await first.createTask({ task });
      const run = { id: "task::run", taskId: "task", revision: 0, status: "running", currentStage: "validate", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), counters: defaultRunCounters() } as TcsfRun; await first.saveRun(run, null);
      const loaded = await second.loadRun(task.id, run.id); const next = { ...loaded, revision: 1, currentStage: "prepare_workspaces" as const }; await first.saveRun(next, loaded.revision); expect((await second.loadRun(task.id, run.id)).currentStage).toBe("prepare_workspaces"); await expect(second.saveRun({ ...next, revision: 2 }, loaded.revision)).rejects.toThrow("run revision conflict");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("rejects symlinked artifact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcsf-symlink-")); const outside = await mkdtemp(join(tmpdir(), "tcsf-outside-"));
    try { const store = new FsArtifactStore(root); const task = { id: "task", revision: 0, phase: "approved", contract: {} } as TcsfTask; await store.createTask({ task }); await symlink(outside, join(root, "tasks", "task", "escape")); await expect(store.writeArtifact("task", "escape/file.txt", new TextEncoder().encode("secret"))).rejects.toThrow("symlink"); }
    finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
  test("enforces critical decision evidence and concrete options", () => {
    const request = { id: "d", taskId: "t", runId: "r", category: "security", question: "Choose", evidence: [{ taskId: "t", relativePath: "evidence.md" }], options: [{ id: "a", label: "A", description: "A", consequences: "A" }, { id: "b", label: "B", description: "B", consequences: "B" }], recommendation: "A", consequenceOfDelay: "pause", requestedAt: new Date().toISOString(), resumeStage: "implement", status: "open" } satisfies DecisionRequest;
    expect(() => validateDecisionRequest(request)).not.toThrow(); expect(() => validateDecisionRequest({ ...request, options: [request.options[0]] })).toThrow();
  });
  test("bounds verification retries", () => { let counters = defaultRunCounters(); expect(canRetry(counters, { infrastructureRetries: 3, protocolRepairs: 1, verificationRepairs: 5, reviewRepairs: 3, candidateValidationRepairs: 2 }, "verification")).toBe(true); for (let i = 0; i < 5; i += 1) counters = incrementRetry(counters, "verification"); expect(canRetry(counters, { infrastructureRetries: 3, protocolRepairs: 1, verificationRepairs: 5, reviewRepairs: 3, candidateValidationRepairs: 2 }, "verification")).toBe(false); });
});
