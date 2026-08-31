import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultFactory } from "./runner.ts";
import type { TcsfFactory } from "./app/factory.ts";

type CandidateRequest = { id?: string; type: string; authToken?: string; seq?: number; scenarioId?: string; manifest?: ScenarioManifest };
type ScenarioManifest = { id: string; operation: string; scenarioRoot: string; taskId: string; packetPath: string; tcsfHome: string; packRunId?: string; packSequence?: number; sourceSnapshotHash?: string };
const authToken = process.argv[2];
if (!authToken) process.exit(2);
let buffer = "";
let shuttingDown = false;
let lastSequence = 0;
let activeScenario: { id: string; manifest: ScenarioManifest; factory: TcsfFactory; controller: AbortController } | undefined;
process.stdout.write(`${JSON.stringify({ type: "ready", protocol: "tcsf-candidate-host", protocolVersion: 1, authToken, pid: process.pid })}\n`);
for await (const chunk of process.stdin) {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let request: CandidateRequest;
    try { request = JSON.parse(line) as CandidateRequest; } catch { send({ type: "response", id: "invalid", success: false, error: "invalid JSON" }); continue; }
    if (request.authToken !== authToken || !Number.isInteger(request.seq) || request.seq! <= lastSequence) { send({ type: "response", id: request.id, success: false, error: "candidate authentication or sequence validation failed" }); continue; }
    lastSequence = request.seq!;
    if (request.type === "shutdown") {
      if (activeScenario) { activeScenario.controller.abort(); await activeScenario.factory.cancelRun(activeScenario.manifest.taskId).catch(() => undefined); }
      send({ type: "response", id: request.id, success: true, seq: lastSequence }); process.exit(0);
    }
    if (request.type === "inspect_registry") { send({ type: "response", id: request.id, success: true, data: { source: import.meta.dir }, seq: lastSequence }); continue; }
    if (request.type === "cancel_scenario") {
      if (!activeScenario || (request.scenarioId && request.scenarioId !== activeScenario.manifest.id)) { send({ type: "response", id: request.id, success: false, error: "no matching cancellable scenario is active", seq: lastSequence }); continue; }
      activeScenario.controller.abort(); await activeScenario.factory.cancelRun(activeScenario.manifest.taskId); send({ type: "response", id: request.id, success: true, seq: lastSequence }); continue;
    }
    if (request.type === "run_scenario") {
      if (!request.manifest || activeScenario) { send({ type: "scenario_result", id: request.id, success: false, error: "candidate authentication or manifest validation failed", seq: lastSequence }); continue; }
      void runScenario(request.id ?? "scenario", request.manifest);
      continue;
    }
    send({ type: "response", id: request.id, success: false, error: `unknown candidate command ${request.type}`, seq: lastSequence });
  }
  if (shuttingDown) break;
}

async function runScenario(id: string, manifest: ScenarioManifest): Promise<void> {
  const controller = new AbortController();
  try {
    if (!manifest.id || !manifest.operation || !manifest.scenarioRoot || !manifest.taskId || !manifest.packetPath || !manifest.tcsfHome) throw new Error("incomplete scenario manifest");
    await mkdir(manifest.scenarioRoot, { recursive: true });
    const packet = JSON.parse(await readFile(manifest.packetPath, "utf8"));
    const factory = createDefaultFactory(manifest.tcsfHome, message => { void emit(manifest, { kind: "notification", message }); }, `candidate-host:${process.pid}`);
    activeScenario = { id, manifest, factory, controller };
    const imported = await factory.importApprovedContract(packet, manifest.scenarioRoot);
    const started = await factory.startRun(imported.id);
    await emit(manifest, { kind: "run_started", taskId: imported.id, runId: started.run.id, driver: started.driver });
    const operation = await performOperation(manifest, factory, imported.id, started.run.id, controller.signal);
    const deadline = Date.now() + 300_000;
    let status = await factory.getStatus(imported.id);
    while (!controller.signal.aborted && Date.now() < deadline && !terminal(status.task.phase, status.run?.status)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      status = await factory.getStatus(imported.id);
    }
    const runRoot = join(manifest.tcsfHome, "tasks", imported.id, "runs", status.run?.id ?? started.run.id);
    const artifactPaths = [join(runRoot, "run.json"), join(runRoot, "driver.json"), join(manifest.tcsfHome, "tasks", imported.id, "task.json")];
    await writeFile(join(manifest.scenarioRoot, "candidate-execution.json"), `${JSON.stringify({ scenarioId: manifest.id, operation: manifest.operation, packRunId: manifest.packRunId, packSequence: manifest.packSequence, sourceSnapshotHash: manifest.sourceSnapshotHash, operationObservations: operation, task: status.task, run: status.run ?? null, driver: started.driver, candidatePid: process.pid, artifactPaths, observedAt: new Date().toISOString() }, null, 2)}\n`);
    await emit(manifest, { kind: "run_terminal", task: status.task, run: status.run ?? null, operationObservations: operation, artifactPaths, candidatePid: process.pid });
    send({ type: "scenario_result", id, success: terminal(status.task.phase, status.run?.status), data: { task: status.task, run: status.run ?? null, operationObservations: operation, artifactPaths, candidatePid: process.pid } });
  } catch (error) {
    await emit(manifest, { kind: "scenario_error", error: String(error) }).catch(() => undefined);
    send({ type: "scenario_result", id, success: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (activeScenario?.id === id) activeScenario = undefined;
  }
}
async function performOperation(manifest: ScenarioManifest, factory: TcsfFactory, taskId: string, runId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (manifest.id === "C-07") {
    const turnsRoot = join(manifest.tcsfHome, "tasks", taskId, "runs", runId, "executions", "turns");
    let firstTurnPersisted = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const turns = await readdir(turnsRoot).catch(() => []);
      if (turns.some(name => name.endsWith(".complete.json"))) { firstTurnPersisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!firstTurnPersisted) return { workerKilled: false, error: "no completed turn was persisted before fault injection" };
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = await factory.getStatus(taskId);
      if (status.run?.activeExecutionId) {
        const execution = await readJson(join(manifest.tcsfHome, "tasks", taskId, "runs", runId, "executions", `${status.run.activeExecutionId}.json`));
        const pid = Number((execution?.host as { metadata?: { pid?: unknown } } | undefined)?.metadata?.pid);
        if (!execution?.activeTurnLogicalId && pid > 0) { try { process.kill(pid, "SIGKILL"); return { workerKilled: true, oldWorkerPid: pid, executionId: status.run.activeExecutionId, firstTurnPersisted: true }; } catch (error) { return { workerKilled: false, firstTurnPersisted: true, error: String(error), oldWorkerPid: pid }; } }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { workerKilled: false, firstTurnPersisted: true, error: "replacement target did not become observable" };
  }
  if (manifest.id === "C-08") {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await factory.getStatus(taskId);
      const executionId = status.run?.activeExecutionId;
      if (executionId) {
        try {
          const foreground = await factory.requestForeground(executionId, "candidate-operator");
          const nonce = (await readJson(join(manifest.tcsfHome, "tasks", taskId, "runs", runId, "foreground", "continuity-nonce.json")))?.continuityNonce;
          if (typeof nonce !== "string") return { foregrounded: foreground.success === true, returned: false, error: "continuity nonce artifact missing" };
          await factory.returnFromForeground(executionId, nonce);
          return { foregrounded: foreground.success === true, returned: true, executionId };
        } catch (error) { return { foregrounded: false, returned: false, error: String(error), executionId }; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { foregrounded: false, returned: false, error: "candidate execution did not become observable" };
  }
  if (manifest.id === "C-06") {
    const existing = await readJson(join(manifest.tcsfHome, "tasks", taskId, "runs", runId, "decision-request.json"));
    const request = { id: `${runId}-candidate-decision`, taskId, runId, category: "behavior_change" as const, question: "Candidate scenario requires an explicit behavior choice.", evidence: [{ taskId, relativePath: "contract/packet.json" }], options: [{ id: "safe", label: "Safe", description: "Choose the safe behavior.", consequences: "The candidate resumes at implementation." }, { id: "compatible", label: "Compatible", description: "Choose compatibility.", consequences: "The candidate resumes at implementation." }], recommendation: "safe", consequenceOfDelay: "The candidate remains paused.", resumeStage: "implement" as const, requestedAt: new Date().toISOString(), status: "open" as const };
    try { const decisionId = typeof existing?.decisionId === "string" ? existing.decisionId : request.id; await factory.resolveDecisionById(decisionId, "safe", "candidate-operator", "candidate conformance decision", taskId); return { decisionPersisted: true, resolved: true, decisionId, existing: Boolean(existing?.decisionId) }; } catch (error) { return { decisionPersisted: false, resolved: false, error: String(error) }; }
  }
  return { workflowStarted: true };
}
async function readJson(path: string): Promise<Record<string, any> | null> { try { const value = JSON.parse(await readFile(path, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; } catch { return null; } }

function terminal(taskPhase: string, runStatus: string | undefined): boolean { return ["ready_for_acceptance", "failed", "cancelled", "completed"].includes(taskPhase) || runStatus === "terminal"; }
async function emit(manifest: ScenarioManifest, event: Record<string, unknown>): Promise<void> { const path = join(manifest.scenarioRoot, "candidate-host-events.jsonl"); await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8"); send({ type: "scenario_event", scenarioId: manifest.id, event }); }
function send(frame: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(frame)}\n`); }
