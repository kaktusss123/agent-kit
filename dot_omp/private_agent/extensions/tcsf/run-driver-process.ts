import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultFactory } from "./runner.ts";

const [, , taskId, runId, tcsfHome, startToken, controllerId, leaseToken] = process.argv;
if (!taskId || !runId || !tcsfHome || !startToken || !controllerId || !leaseToken) process.exit(2);
const runRoot = join(tcsfHome, "tasks", taskId, "runs", runId); await mkdir(runRoot, { recursive: true });
const manifestPath = join(runRoot, "driver.json"); const tracePath = join(runRoot, "driver-events.jsonl");
await writeFile(join(runRoot, "driver-identity.json"), `${JSON.stringify({ taskId, runId, startToken, controllerId, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
const factory = createDefaultFactory(tcsfHome, message => { void trace({ state: "notification", message }); }, controllerId, leaseToken); const shutdown = new AbortController();
process.on("SIGTERM", () => shutdown.abort()); process.on("SIGINT", () => shutdown.abort());
async function trace(event: Record<string, unknown>): Promise<void> { await appendFile(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8"); }
async function readManifest(): Promise<Record<string, unknown>> { const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("driver manifest is not an object"); return parsed as Record<string, unknown>; }
async function renew(): Promise<void> { const manifest = await readManifest(); if (manifest.startToken !== startToken) throw new Error("run driver lease token mismatch"); const next = { ...manifest, pid: process.pid, state: "running", heartbeatAt: new Date().toISOString() }; const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`); await rename(temporary, manifestPath); }
const heartbeat = setInterval(() => { void renew().catch(error => { void trace({ state: "heartbeat_error", error: String(error) }); shutdown.abort(); }); }, 1_000);
let reachedTerminal = false;
try {
  let previousRevision = -1;
  while (!shutdown.signal.aborted) {
    await renew(); const startedAt = Date.now(); const before = await readManifest(); await trace({ state: "advance_begin", stage: before.currentStage ?? "unknown" });
    const result = await factory.advanceRun(taskId); if (result.run.revision <= previousRevision) throw new Error(`driver made no durable progress at revision ${result.run.revision}`); previousRevision = result.run.revision;
    await trace({ state: result.state, stage: result.run.currentStage, taskPhase: result.task.phase, revision: result.run.revision, durationMs: Date.now() - startedAt });
    if (result.state !== "advanced") { reachedTerminal = result.state === "terminal"; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} catch (error) { await trace({ state: "error", error: String(error) }); process.exitCode = 1; } finally { clearInterval(heartbeat); const finalState = reachedTerminal && (process.exitCode ?? 0) === 0 ? "stopped" : "failed"; try { const manifest = await readManifest(); if (manifest.startToken === startToken) { const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify({ ...manifest, pid: process.pid, state: finalState, exitCode: process.exitCode ?? 0, exitedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }, null, 2)}\n`); await rename(temporary, manifestPath); } } catch (error) { await trace({ state: "manifest_update_error", error: String(error) }); process.exitCode = 1; } await rm(join(runRoot, "driver.claim"), { force: true }); await trace({ state: "stopped", reason: shutdown.signal.aborted ? "shutdown" : "terminal", finalState }); }
