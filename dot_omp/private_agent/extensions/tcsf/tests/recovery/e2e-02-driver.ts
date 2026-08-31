import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsArtifactStore } from "../../adapters/fs-artifact-store.ts";
import { FsContractImporter } from "../../adapters/fs-contract-importer.ts";
import { createGitWorkspace } from "../../adapters/git-workspace.ts";
import { LocalProcessHost } from "../../adapters/local-process-host.ts";
import { LocalRunDriverHost } from "../../adapters/local-run-driver-host.ts";
import { OmpCandidateRuntime } from "../../adapters/omp/candidate-runtime.ts";
import { OmpRpcAgentRuntime } from "../../adapters/omp/rpc-runtime.ts";
import { OmpReviewer } from "../../adapters/omp/reviewer.ts";
import { ShellVerificationRunner } from "../../adapters/shell-verification.ts";
import { TcsfFactory } from "../../app/factory.ts";
import type { VerificationRunInput, VerificationRunResult, VerificationRunner } from "../../ports/verification.ts";

const [, , taskId, runId, tcsfHome, startToken, controllerId, leaseToken] = process.argv;
if (!taskId || !runId || !tcsfHome || !startToken || !controllerId || !leaseToken) process.exit(2);
const runRoot = join(tcsfHome, "tasks", taskId, "runs", runId);
const manifestPath = join(runRoot, "driver.json");
const tracePath = join(runRoot, "driver-events.jsonl");
await mkdir(runRoot, { recursive: true });
await writeFile(join(runRoot, "driver-identity.json"), `${JSON.stringify({ taskId, runId, startToken, controllerId, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);

class FailFirstVerification implements VerificationRunner {
  private invocation = 0;
  constructor(private readonly delegate: VerificationRunner) {}
  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    const result = await this.delegate.run(input);
    this.invocation += 1;
    await writeFile(join(input.artifactDir, `injected-verification-${this.invocation}.json`), `${JSON.stringify({ invocation: this.invocation, selected: this.invocation === 1, observedAt: new Date().toISOString() }, null, 2)}\n`);
    if (this.invocation !== 1) return result;
    const first = result.commandResults[0];
    return { ...result, passed: false, commandResults: first ? [{ ...first, passed: false, failureMetadata: { failureType: "nonzero_exit", isRetriable: true } }, ...result.commandResults.slice(1)] : result.commandResults };
  }
}

const factory = new TcsfFactory({ artifacts: new FsArtifactStore(tcsfHome), decisions: { publish: async () => {}, readResolution: async () => null }, contractImporter: new FsContractImporter(), controllerId, leaseToken, agentRuntime: new OmpRpcAgentRuntime(), reviewer: new OmpReviewer(new OmpRpcAgentRuntime(), join(tcsfHome, "sessions")), candidateRuntime: new OmpCandidateRuntime(), executionHost: new LocalProcessHost(join(tcsfHome, "hosts")), runDriverHost: new LocalRunDriverHost(tcsfHome), workspace: createGitWorkspace(), verification: new FailFirstVerification(new ShellVerificationRunner()) });
const shutdown = new AbortController(); process.on("SIGTERM", () => shutdown.abort()); process.on("SIGINT", () => shutdown.abort());
async function trace(event: Record<string, unknown>): Promise<void> { await appendFile(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8"); }
async function manifest(): Promise<Record<string, unknown>> { const value = JSON.parse(await readFile(manifestPath, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("driver manifest is not an object"); return value as Record<string, unknown>; }
async function renew(): Promise<void> { const current = await manifest(); if (current.startToken !== startToken) throw new Error("driver start token mismatch"); const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify({ ...current, pid: process.pid, state: "running", heartbeatAt: new Date().toISOString() }, null, 2)}\n`); await rename(temporary, manifestPath); }
const heartbeat = setInterval(() => { void renew().catch(error => { void trace({ state: "heartbeat_error", error: String(error) }); shutdown.abort(); }); }, 1_000);
let terminal = false;
try {
  let previousRevision = -1;
  while (!shutdown.signal.aborted) {
    await renew(); const startedAt = Date.now(); const before = await manifest(); await trace({ state: "advance_begin", stage: before.currentStage ?? "unknown" });
    const result = await factory.advanceRun(taskId); if (result.run.revision <= previousRevision) throw new Error(`driver made no durable progress at revision ${result.run.revision}`); previousRevision = result.run.revision;
    await trace({ state: result.state, stage: result.run.currentStage, taskPhase: result.task.phase, revision: result.run.revision, durationMs: Date.now() - startedAt });
    if (result.state !== "advanced") { terminal = result.state === "terminal"; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} catch (error) { await trace({ state: "error", error: String(error) }); process.exitCode = 1; } finally { clearInterval(heartbeat); const current = await manifest().catch(() => ({})); const state = terminal && (process.exitCode ?? 0) === 0 ? "stopped" : "failed"; await writeFile(manifestPath, `${JSON.stringify({ ...current, pid: process.pid, state, exitCode: process.exitCode ?? 0, exitedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }, null, 2)}\n`).catch(error => { void trace({ state: "manifest_update_error", error: String(error) }); process.exitCode = 1; }); }
