import { transitionRun, transitionTask } from "../core/state.ts";
import type { AgentRuntime } from "../ports/agent-runtime.ts";
import type { RunDriverHost, RunDriverRef } from "../ports/run-driver-host.ts";
import type { ExecutionHost } from "../ports/execution-host.ts";
import type { WorkspacePort, WorkspaceSet } from "../ports/workspace.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { HumanDecisionPort } from "../ports/human-decision.ts";
import type { VerificationRunner, VerificationCommand } from "../ports/verification.ts";
import type { CandidateRuntimePort } from "../ports/candidate-runtime.ts";
import type { ReviewPort } from "../ports/review.ts";
import type { ContractImporter } from "../ports/contract-import.ts";
import type { FailpointPort } from "../ports/failpoint.ts";
import type { AgentSessionHandle, AgentSessionRef, AgentTurnRef, AgentTurnResult, ApprovedContractPacket, DecisionRequest, DecisionResolution, ExecutionRecord, FailureClass, TcsfEvent, TcsfRun, TcsfTask, WriterOwner } from "../core/types.ts";
import type { ReviewResult } from "../core/review.ts";
import { DEFAULT_RETRY_POLICY } from "../core/types.ts";
import { defaultRunCounters, canRetry, incrementRetry } from "../core/policy.ts";
import { validateDecisionRequest, validateDecisionResolution } from "../core/decisions.ts";
const RUN_SEPARATOR = "::";
import { isSelfChange } from "./self-development.ts";
export interface ModelRouter { resolve(role: "implementer" | "reviewer" | "candidate-validator"): string | undefined; }
export interface TcsfFactoryDeps { agentRuntime: AgentRuntime; executionHost: ExecutionHost; runDriverHost: RunDriverHost; workspace: WorkspacePort; artifacts: ArtifactStore; verification: VerificationRunner; decisions: HumanDecisionPort; contractImporter: ContractImporter; reviewer?: ReviewPort; candidateRuntime?: CandidateRuntimePort; modelRouter?: ModelRouter; clock?: () => Date; controllerId?: string; leaseToken?: string; leaseRenewIntervalMs?: number; failpoint?: FailpointPort; }
export interface StartRunResult { task: TcsfTask; run: TcsfRun; driver: RunDriverRef; }
export interface AdvanceResult { task: TcsfTask; run: TcsfRun; state: "advanced" | "waiting" | "terminal" | "failed"; }
interface RootedArtifactStore extends ArtifactStore { readonly root?: string; }

class StageLeaseLostError extends Error {}

export class TcsfFactory {
  private readonly clock: () => Date;
  private readonly controllerId: string;
  private readonly workspaces = new Map<string, WorkspaceSet>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly handles = new Map<string, { session: AgentSessionRef; handle: AgentSessionHandle }>();
  private readonly activeTurns = new Map<string, { handle: AgentSessionHandle; turn: AgentTurnRef }>();
  private readonly drivers = new Map<string, RunDriverRef>();
  private readonly pendingDecisions = new Map<string, DecisionRequest>();
  private async recordEvent(taskId: string, eventType: TcsfEvent["eventType"], runId: string | undefined, sequence: number, executionId?: string): Promise<void> { const event: TcsfEvent = { eventType, taskId, runId, executionId, timestamp: this.now(), sequence }; await this.deps.artifacts.appendEvent(taskId, event); }
  constructor(private readonly deps: TcsfFactoryDeps) { this.clock = deps.clock ?? (() => new Date()); this.controllerId = deps.controllerId ?? "tcsf-controller"; }
  private now(): string { return this.clock().toISOString(); }
  private root(): string { const store = this.deps.artifacts as RootedArtifactStore; return store.root ?? ".omp/tcsf"; }
  private async loadDecision(taskId: string, decisionId: string): Promise<DecisionRequest | undefined> { try { return JSON.parse(new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId, relativePath: `decisions/${decisionId}.json` }))) as DecisionRequest; } catch { return undefined; } }
  async importApprovedContract(packet: ApprovedContractPacket, sourceRoot = process.cwd()): Promise<TcsfTask> {
    this.validatePacket(packet);
    const frozen = await this.deps.contractImporter.import(packet, sourceRoot);
    const now = this.now();
    const task: TcsfTask = { id: packet.taskId, revision: 0, phase: "approved", contract: packet, createdAt: now, updatedAt: now, counters: { implementationAttempts: 0, reviewRounds: 0, candidateValidationRounds: 0, decisionRequests: 0 } };
    await this.deps.artifacts.createTask({ task });
    await this.recordEvent(task.id, "task_created", undefined, 0);
    await this.deps.artifacts.writeArtifact(task.id, "contract/packet.json", new TextEncoder().encode(`${JSON.stringify(packet, null, 2)}\n`));
    for (const artifact of frozen.artifacts) await this.deps.artifacts.writeArtifact(task.id, artifact.copiedPath, artifact.bytes);
    const manifest = { schemaVersion: 1, importedAt: frozen.importedAt, snapshotSha256: frozen.snapshotSha256, artifacts: frozen.artifacts.map(({ bytes: _bytes, ...artifact }) => artifact) };
    await this.deps.artifacts.writeArtifact(task.id, "contract/frozen-manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    return task;
  }

  async startRun(taskId: string): Promise<StartRunResult> {
    const task = await this.deps.artifacts.loadTask(taskId);
    if (task.activeRunId) throw new Error(`task already has active run ${task.activeRunId}`);
    const runId = `${taskId}${RUN_SEPARATOR}${Date.now().toString(36)}`; const leaseToken = `${runId}-${Math.random().toString(36).slice(2)}`;
    const run: TcsfRun = { id: runId, taskId, revision: 0, status: "running", currentStage: "validate", createdAt: this.now(), updatedAt: this.now(), counters: defaultRunCounters(), lease: { holderId: this.controllerId, acquiredAt: this.now(), expiresAt: new Date(this.clock().getTime() + 60_000).toISOString(), token: leaseToken } };
    await this.saveRun(run, null);
    await this.recordEvent(taskId, "run_created", run.id, run.revision);
    const prepared = transitionTask(task, "preparing");
    const withRun = { ...prepared, activeRunId: run.id };
    await this.deps.artifacts.saveTask(withRun, task.revision);
    const driver = await this.deps.runDriverHost.start({ taskId, runId: run.id, tcsfHome: this.root(), controllerId: this.controllerId, leaseToken }); this.drivers.set(run.id, driver);
    return { task: withRun, run, driver };
  }

  async resumeRun(taskId: string): Promise<StartRunResult> {
    const task = await this.deps.artifacts.loadTask(taskId);
    if (!task.activeRunId) return this.startRun(taskId);
    const run = await this.loadRun(task.activeRunId); if (["terminal", "failed", "cancelled"].includes(run.status)) throw new Error(`run is terminal: ${run.status}`);
    const now = this.clock().getTime(); const lease = run.lease; let ownedRun = run; let tookOver = false;
    if (!lease || new Date(lease.expiresAt).getTime() <= now) {
      const replacement = { ...run, revision: run.revision + 1, updatedAt: this.now(), lease: { holderId: this.controllerId, acquiredAt: this.now(), expiresAt: new Date(now + 60_000).toISOString(), token: `${run.id}-${Math.random().toString(36).slice(2)}` } };
      await this.saveRun(replacement, run.revision); ownedRun = replacement; tookOver = true;
    } else {
      if (lease.holderId !== this.controllerId) throw new Error(`run ${run.id} is owned by ${lease.holderId}`);
      if (this.deps.leaseToken && lease.token !== this.deps.leaseToken) throw new Error(`run ${run.id} lease token mismatch`);
    }
    if (tookOver && ownedRun.activeExecutionId) {
      const execution = await this.loadExecution(ownedRun.activeExecutionId);
      if (execution?.writerLease) {
        try { await this.deps.executionHost.releaseWriter(execution.writerLease); } catch (error) { if (!isIdempotentLeaseReleaseError(error)) throw error; }
        await this.writeExecution(task.id, { ...execution, status: "idle", writerLease: undefined, lastHeartbeatAt: this.now() });
        await this.recordEvent(task.id, "lease_released", ownedRun.id, ownedRun.revision, execution.id);
      }
    }
    const driver = await this.deps.runDriverHost.start({ taskId, runId: ownedRun.id, tcsfHome: this.root(), controllerId: ownedRun.lease?.holderId ?? this.controllerId, leaseToken: ownedRun.lease?.token }); this.drivers.set(ownedRun.id, driver);
    return { task, run: ownedRun, driver };
  }

  async getStatus(taskId: string): Promise<{ task: TcsfTask; run?: TcsfRun }> { const task = await this.deps.artifacts.loadTask(taskId); return { task, run: task.activeRunId ? await this.loadRun(task.activeRunId) : undefined }; }

  async advanceRun(taskId: string): Promise<AdvanceResult> {
    const task = await this.deps.artifacts.loadTask(taskId);
    if (!task.activeRunId) throw new Error("task has no active run");
    let run = await this.loadRun(task.activeRunId); this.assertRunLease(run); run = await this.renewRunLease(run);
    if (this.wallTimeExpired(task, run)) return this.fail(task, run, "policy", `run exceeded max wall time of ${task.contract.policy.maxWallTimeHours} hours`);
    try {
      if (run.currentStage === "validate") return await this.advanceValidation(task, run);
      if (run.currentStage === "prepare_workspaces") return await this.advancePreparation(task, run);
      if (run.currentStage === "implement") return await this.advanceImplementation(task, run);
      if (run.currentStage === "verify") return await this.withStageLease(task, run, "verification", signal => this.advanceVerification(task, run, signal));
      if (run.currentStage === "review") return await this.withStageLease(task, run, "review", signal => this.advanceReview(task, run, signal));
      if (run.currentStage === "candidate_validate") return await this.withStageLease(task, run, "candidate", signal => this.advanceCandidate(task, run, signal));
      if (run.currentStage === "waiting_for_decision" || run.currentStage === "waiting_for_operator") return await this.advanceWaiting(task, run);
      return { task, run, state: run.status === "failed" ? "failed" : "terminal" };
    } catch (error) { if (error instanceof StageLeaseLostError) throw error; if (error instanceof Error && error.message.includes("writer lease held")) return { task, run, state: "waiting" }; return this.fail(task, run, "protocol", error instanceof Error ? error.message : String(error)); }
  }
  async requestForeground(executionId: string, operatorId: string) {
    let execution = await this.loadExecution(executionId); if (!execution) throw new Error(`unknown execution ${executionId}`);
    const active = this.handles.get(executionId); if (active) { await this.deps.agentRuntime.close(active.handle); this.handles.delete(executionId); }
    const taskId = taskIdFromRunId(execution.runId);
    const continuityNonce = crypto.randomUUID();
    await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/foreground/continuity-nonce.json`, new TextEncoder().encode(`${JSON.stringify({ executionId, continuityNonce, issuedAt: this.now(), consumed: false })}\n`));
    try {
      const result = await this.deps.executionHost.foreground(execution.host, { operatorId, capability: execution.foregroundCapability, continuityNonce });
      if (result.success) { const foregrounded = { ...execution, status: "foregrounded" as const, writerLease: result.writerLease }; this.executions.set(executionId, foregrounded); await this.writeExecution(taskId, foregrounded); if (result.writerLease) await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/foreground/writer-lease.json`, new TextEncoder().encode(`${JSON.stringify(result.writerLease, null, 2)}\n`)); await this.recordEvent(taskId, "foreground_requested", execution.runId, Date.now(), executionId); }
      return result;
    } catch (error) {
      const resumed = await this.deps.agentRuntime.resumeSession(execution.agentSession); this.handles.set(executionId, { session: execution.agentSession, handle: resumed }); throw error;
    }
  }
  async returnFromForeground(executionId: string, continuityNonce?: string): Promise<void> {
    const execution = await this.loadExecution(executionId); if (!execution) throw new Error(`unknown execution ${executionId}`); if (execution.status !== "foregrounded") throw new Error(`execution is not foregrounded: ${execution.status}`); if (!continuityNonce) throw new Error("continuity nonce required to return foreground control");
    const taskId = taskIdFromRunId(execution.runId); const data = await this.deps.artifacts.readArtifact({ taskId, relativePath: `runs/${execution.runId}/foreground/continuity-nonce.json` });
    const record = JSON.parse(new TextDecoder().decode(data)) as { executionId?: string; continuityNonce?: string; consumed?: boolean };
    if (record.consumed || record.executionId !== executionId || record.continuityNonce !== continuityNonce) throw new Error("continuity nonce mismatch or already consumed");
    try {
      const leaseData = await this.deps.artifacts.readArtifact({ taskId, relativePath: `runs/${execution.runId}/foreground/writer-lease.json` });
      await this.deps.executionHost.releaseWriter(JSON.parse(new TextDecoder().decode(leaseData)));
    } catch (error) {
      if (!isMissingArtifact(error)) throw error;
    }
    const consumed = new TextEncoder().encode(`${JSON.stringify({ ...record, consumed: true, consumedAt: this.now() })}\n`);
    if (this.deps.artifacts.claimArtifact) {
      await this.deps.artifacts.claimArtifact(taskId, `runs/${execution.runId}/foreground/continuity-nonce.consumed`, consumed);
      await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/foreground/continuity-nonce.json`, consumed);
    } else {
      await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/foreground/continuity-nonce.json`, consumed);
    }
    const running = { ...execution, status: "running" as const }; this.executions.set(executionId, running);
    await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/executions/${executionId}.json`, new TextEncoder().encode(`${JSON.stringify(running, null, 2)}\n`));
    await this.recordEvent(taskId, "foreground_returned", execution.runId, Date.now(), executionId); this.handles.delete(executionId);
  }
  async resolveDecisionById(decisionId: string, selectedOptionId: string, resolvedBy: string, rationale?: string, taskId?: string): Promise<void> { const request = this.pendingDecisions.get(decisionId) ?? (taskId ? await this.loadDecision(taskId, decisionId) : undefined); if (!request) throw new Error(`unknown decision ${decisionId}; provide its task id after a restart`); await this.resolveDecision({ decisionId, selectedOptionId, resolvedBy, rationale, resolvedAt: this.now() }, request); }
  async requestDecision(request: DecisionRequest): Promise<void> { validateDecisionRequest(request); this.pendingDecisions.set(request.id, request); const encoded = new TextEncoder().encode(`${JSON.stringify(request, null, 2)}\n`); await this.deps.artifacts.writeArtifact(request.taskId, `runs/${request.runId}/decisions/${request.id}.json`, encoded); await this.deps.artifacts.writeArtifact(request.taskId, `decisions/${request.id}.json`, encoded); const run = await this.loadRun(request.runId); const waitingRun = await this.moveRun(run, "waiting_for_decision"); await this.deps.artifacts.writeArtifact(request.taskId, `runs/${request.runId}/decision-request.json`, new TextEncoder().encode(`${JSON.stringify({ decisionId: request.id, resumeStage: request.resumeStage })}\n`)); const task = await this.deps.artifacts.loadTask(request.taskId); const waitingTask = transitionTask({ ...task, counters: { ...task.counters, decisionRequests: task.counters.decisionRequests + 1 } }, "waiting_for_decision"); await this.deps.artifacts.saveTask({ ...waitingTask, activeRunId: waitingRun.id }, task.revision); await this.deps.decisions.publish(request); }
  async resolveDecision(resolution: DecisionResolution, request?: DecisionRequest): Promise<void> {
    const resolvedRequest = request ?? this.pendingDecisions.get(resolution.decisionId); if (!resolvedRequest) throw new Error(`unknown decision ${resolution.decisionId}`); validateDecisionResolution(resolvedRequest, resolution);
    const resolutionPath = `runs/${resolvedRequest.runId}/decisions/${resolvedRequest.id}.resolution.json`; let persisted = false; try { const prior = JSON.parse(new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId: resolvedRequest.taskId, relativePath: resolutionPath }))) as DecisionResolution; if (JSON.stringify(prior) !== JSON.stringify(resolution)) throw new Error(`decision ${resolvedRequest.id} already has a different resolution`); persisted = true; } catch (error) { if (!isMissingArtifact(error)) throw error; }
    this.pendingDecisions.delete(resolvedRequest.id); if (!persisted) await this.deps.artifacts.writeArtifact(resolvedRequest.taskId, resolutionPath, new TextEncoder().encode(`${JSON.stringify(resolution, null, 2)}\n`)); const run = await this.loadRun(resolvedRequest.runId); if (run.currentStage !== "waiting_for_decision") throw new Error(`decision ${resolvedRequest.id} cannot resolve run in stage ${run.currentStage}`); const nextRun = await this.moveRun(run, resolvedRequest.resumeStage); const task = await this.deps.artifacts.loadTask(resolvedRequest.taskId); const phase = resolvedRequest.resumeStage === "implement" ? "implementing" : resolvedRequest.resumeStage === "verify" ? "verifying" : resolvedRequest.resumeStage === "review" ? "reviewing" : "candidate_validating"; await this.deps.artifacts.saveTask({ ...transitionTask(task, phase), activeRunId: nextRun.id }, task.revision);
  }
  private async advanceWaiting(task: TcsfTask, run: TcsfRun): Promise<AdvanceResult> {
    let requestRef: { decisionId?: string }; try { requestRef = JSON.parse(new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId: task.id, relativePath: `runs/${run.id}/decision-request.json` }))) as { decisionId?: string }; } catch (error) { return isMissingArtifact(error) ? this.fail(task, run, "policy", "persisted decision request is missing") : this.fail(task, run, "policy", "persisted decision request is malformed"); }
    if (!requestRef.decisionId) return this.fail(task, run, "policy", "persisted decision request has no decision id"); const request = await this.loadDecision(task.id, requestRef.decisionId); if (!request) return this.fail(task, run, "policy", "persisted decision request is unreadable");
    let resolution: DecisionResolution; try { resolution = JSON.parse(new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId: task.id, relativePath: `runs/${run.id}/decisions/${requestRef.decisionId}.resolution.json` }))) as DecisionResolution; } catch (error) { return isMissingArtifact(error) ? { task, run, state: "waiting" } : this.fail(task, run, "policy", "persisted decision resolution is malformed"); }
    try { await this.resolveDecision(resolution, request); } catch (error) { return this.fail(task, run, "policy", error instanceof Error ? error.message : String(error)); } return { task: await this.deps.artifacts.loadTask(task.id), run: await this.loadRun(run.id), state: "advanced" };
  }

  private async repairContext(taskId: string, runId: string): Promise<string> { try { return new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId, relativePath: `runs/${runId}/repair-context.json` })); } catch { return "No prior repair context is available."; } }
  private async frozenContractContext(taskId: string): Promise<string> { const read = async (relativePath: string): Promise<string> => new TextDecoder().decode(await this.deps.artifacts.readArtifact({ taskId, relativePath })); const manifest = await read("contract/frozen-manifest.json"); const spec = await read("contract/spec.md"); const verification = await read("contract/verification.json"); return `Frozen contract manifest:\n${manifest}\nFrozen specification:\n${spec}\nFrozen verification contract:\n${verification}`; }
  async cancelRun(taskId: string): Promise<TcsfTask> {
    const task = await this.deps.artifacts.loadTask(taskId);
    if (!task.activeRunId || task.phase === "cancelled" || task.phase === "failed" || task.phase === "ready_for_acceptance" || task.phase === "completed") return task;
    let run = await this.loadRun(task.activeRunId);
    if (run.status === "terminal" || run.status === "failed" || run.status === "cancelled") return task;
    if (run.status !== "cancelling") { const intent = { ...run, status: "cancelling" as const, revision: run.revision + 1, updatedAt: this.now() }; await this.saveRun(intent, run.revision); run = intent; }
    const cleanupErrors: string[] = []; const execution = run.activeExecutionId ? await this.loadExecution(run.activeExecutionId) : undefined; const active = run.activeExecutionId ? this.handles.get(run.activeExecutionId) : undefined; const turn = run.activeExecutionId ? this.activeTurns.get(run.activeExecutionId) : undefined;
    if (turn) { try { await this.deps.agentRuntime.interruptTurn(turn.handle, turn.turn); } catch (error) { cleanupErrors.push(`interrupt: ${error instanceof Error ? error.message : String(error)}`); } finally { this.activeTurns.delete(run.activeExecutionId!); } }
    if (active) { try { await this.deps.agentRuntime.close(active.handle); } catch (error) { cleanupErrors.push(`close: ${error instanceof Error ? error.message : String(error)}`); } finally { this.handles.delete(run.activeExecutionId!); } }
    if (execution?.writerLease) { try { await this.deps.executionHost.releaseWriter(execution.writerLease); } catch (error) { if (!isIdempotentLeaseReleaseError(error)) cleanupErrors.push(`writer lease release: ${error instanceof Error ? error.message : String(error)}`); } }
    if (execution) { try { await this.deps.executionHost.stop(execution.host, "force"); } catch (error) { cleanupErrors.push(`execution stop: ${error instanceof Error ? error.message : String(error)}`); } }
    const driver = this.drivers.get(run.id); if (driver) { try { await this.deps.runDriverHost.stop(driver, "force"); } catch (error) { cleanupErrors.push(`driver stop: ${error instanceof Error ? error.message : String(error)}`); } finally { this.drivers.delete(run.id); } } else if (this.deps.runDriverHost.stopForRun) { try { await this.deps.runDriverHost.stopForRun(task.id, run.id, "force"); } catch (error) { cleanupErrors.push(`driver stop: ${error instanceof Error ? error.message : String(error)}`); } }
    let driverState: unknown = { state: "stopped", observedAt: this.now() }; if (driver) { try { driverState = await this.deps.runDriverHost.inspect(driver); } catch (error) { cleanupErrors.push(`driver inspect: ${error instanceof Error ? error.message : String(error)}`); } }
    await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/cancellation/orphan-inspection.json`, new TextEncoder().encode(`${JSON.stringify({ executionId: run.activeExecutionId, driver: driverState, observedAt: this.now() }, null, 2)}\n`));
    if (cleanupErrors.length > 0) {
      const failedRun = { ...run, status: "failed" as const, currentStage: "failed" as const, revision: run.revision + 1, lease: undefined, blocker: { category: "infrastructure" as const, message: `cancellation cleanup failed: ${cleanupErrors.join("; ")}`, retryable: false, since: this.now() } };
      await this.saveRun(failedRun, run.revision); await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/cancellation/failure.json`, new TextEncoder().encode(`${JSON.stringify({ errors: cleanupErrors, observedAt: this.now() }, null, 2)}\n`)); return this.deps.artifacts.saveTask(transitionTask(task, "failed"), task.revision);
    }
    const cancelledRun = { ...run, status: "cancelled" as const, currentStage: "failed" as const, revision: run.revision + 1, lease: undefined, blocker: { category: "cancelled", message: "cancelled by operator", retryable: false, since: this.now() } }; await this.saveRun(cancelledRun, run.revision);
    if (execution) { const cancelled = { ...execution, status: "cancelled" as const, writerLease: undefined, finishedAt: this.now() }; this.executions.set(execution.id, cancelled); await this.writeExecution(task.id, cancelled); }
    return this.deps.artifacts.saveTask(transitionTask(task, "cancelled"), task.revision);
  }
  async acceptTask(taskId: string): Promise<TcsfTask> { const task = await this.deps.artifacts.loadTask(taskId); return this.deps.artifacts.saveTask(transitionTask(task, "completed"), task.revision); }
  private async loadExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    const suffix = "-implementer"; if (!executionId.endsWith(suffix)) return undefined;
    const run = await this.loadRun(executionId.slice(0, -suffix.length)); const data = await this.deps.artifacts.readArtifact({ taskId: run.taskId, relativePath: `runs/${run.id}/executions/${executionId}.json` }); return JSON.parse(new TextDecoder().decode(data)) as ExecutionRecord;
  }
  private async workspaceFor(task: TcsfTask, run: TcsfRun): Promise<WorkspaceSet> {
    const cached = this.workspaces.get(run.id); if (cached) return cached;
    const set = await this.deps.workspace.prepareTaskWorkspaces({ taskId: task.id, taskRoot: this.root(), repositories: task.contract.repositories, worktreesDir: `${this.root()}/tasks/${task.id}/worktrees` });
    await this.deps.workspace.validateWorkspaceSet(set); this.workspaces.set(run.id, set); return set;
  }
  private async advanceValidation(task: TcsfTask, run: TcsfRun): Promise<AdvanceResult> { this.validatePacket(task.contract); if (isSelfChange(task.contract.repositories)) await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/self-development/required.json`, new TextEncoder().encode(`${JSON.stringify({ required: true, reason: "TCSF source changes require candidate validation" })}\n`)); const next = await this.moveRun(run, "prepare_workspaces"); return { task, run: next, state: "advanced" }; }
  private async advancePreparation(task: TcsfTask, run: TcsfRun): Promise<AdvanceResult> { const set = await this.deps.workspace.prepareTaskWorkspaces({ taskId: task.id, taskRoot: this.root(), repositories: task.contract.repositories, worktreesDir: `${this.root()}/tasks/${task.id}/worktrees` }); await this.deps.workspace.validateWorkspaceSet(set); this.workspaces.set(run.id, set); const nextRun = await this.moveRun(run, "implement"); const nextTask = transitionTask(task, "implementing"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" }; }
  private async advanceImplementation(task: TcsfTask, run: TcsfRun): Promise<AdvanceResult> {
    const attempts = task.counters.implementationAttempts + 1; const attemptTask = { ...task, counters: { ...task.counters, implementationAttempts: attempts } };
    if (attempts > task.contract.policy.maxImplementationRetries + 1) return this.fail(task, run, "semantic", "implementation retry limit exhausted");
    const set = await this.workspaceFor(task, run); const workspace = [...set.workspaces.values()].find(item => item.role !== "reference"); if (!workspace?.worktreePath) throw new Error("no writable worktree");
    let execution = run.activeExecutionId ? await this.loadExecution(run.activeExecutionId) : undefined;
    if (!execution) {
      const session = await this.deps.agentRuntime.createSession({ cwd: workspace.worktreePath, workspaceRoots: [workspace.worktreePath], readOnlyRoots: task.contract.repositories.filter(repository => repository.role === "reference").map(repository => repository.canonicalPath), systemPrompt: "You are the TCSF implementer. Implement the frozen approved contract in the allowed worktree. End when ready for factory-owned verification.", role: "implementer", sessionDirectory: `${this.root()}/sessions`, model: this.deps.modelRouter?.resolve("implementer") });
      const handle = await this.deps.agentRuntime.resumeSession(session); const executionId = `${run.id}-implementer`; const host = await this.deps.executionHost.start({ executionId, cwd: workspace.worktreePath, session: session.sessionId, processId: handle.processId });
      execution = { id: executionId, runId: run.id, role: "implementer", purpose: "implement approved contract", status: "running", agentRuntimeKind: this.deps.agentRuntime.kind, agentSession: session, executionHostKind: this.deps.executionHost.kind, host, foregroundCapability: "handoff", workspaceRoots: [workspace.worktreePath], readOnlyRoots: [] , createdAt: this.now() };
      this.executions.set(executionId, execution); this.handles.set(executionId, { session, handle }); const withExecution = { ...run, activeExecutionId: executionId, revision: run.revision + 1, updatedAt: this.now() }; await this.saveRun(withExecution, run.revision); run = withExecution; await this.writeExecution(task.id, execution);
    }
    if (!this.handles.has(execution.id)) { const handle = await this.deps.agentRuntime.resumeSession(execution.agentSession); this.handles.set(execution.id, { session: execution.agentSession, handle }); }
    if (execution.activeTurnLogicalId && execution.activeTurnPrompt && this.deps.agentRuntime.reconcileTurn) {
      const reconciliation = await this.deps.agentRuntime.reconcileTurn(execution.agentSession, { logicalTurnId: execution.activeTurnLogicalId, prompt: execution.activeTurnPrompt, contentHash: execution.activeTurnContentHash ?? "" });
      if (reconciliation === "unknown") return this.fail(attemptTask, run, "protocol", `cannot determine whether dispatched logical turn ${execution.activeTurnLogicalId} was accepted`);
      const staleHandle = this.handles.get(execution.id);
      if (staleHandle) { await this.deps.agentRuntime.close(staleHandle.handle).catch(() => undefined); this.handles.delete(execution.id); }
      if (reconciliation === "completed") {
        const reconciled = { ...execution, activeTurnId: undefined, activeTurnLogicalId: undefined, activeTurnContentHash: undefined, activeTurnPrompt: undefined, status: "idle" as const, lastTerminalTurnAt: this.now() };
        await this.writeExecution(task.id, reconciled);
        run = await this.loadRun(run.id);
        const nextRun = await this.moveRun(run, "verify"); const nextTask = transitionTask(attemptTask, "verifying"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
      }
      execution = { ...execution, activeTurnId: undefined, activeTurnLogicalId: undefined, activeTurnContentHash: undefined, activeTurnPrompt: undefined, status: "idle" };
      await this.writeExecution(task.id, execution);
    }
    const hostStatus = await this.deps.executionHost.inspect(execution.host);
    if (hostStatus.state !== "running") {
      const stale = this.handles.get(execution.id);
      if (stale) { await this.deps.agentRuntime.close(stale.handle).catch(() => undefined); this.handles.delete(execution.id); }
      const replacement = await this.deps.agentRuntime.resumeSession(execution.agentSession);
      this.handles.set(execution.id, { session: execution.agentSession, handle: replacement });
      const replacementHost = await this.deps.executionHost.start({ executionId: execution.id, cwd: workspace.worktreePath, session: replacement.ref.sessionId, processId: replacement.processId });
      execution = { ...execution, host: replacementHost, status: "idle" };
      this.executions.set(execution.id, execution);
      await this.writeExecution(task.id, execution);
      await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/recovery/worker-replacement.json`, new TextEncoder().encode(`${JSON.stringify({ priorHost: hostStatus, replacementHost, sessionId: replacement.ref.sessionId, sameLogicalSession: replacement.ref.sessionId === execution.agentSession.sessionId, at: this.now() }, null, 2)}\n`));
    }
    if (!this.handles.has(execution.id)) { const handle = await this.deps.agentRuntime.resumeSession(execution.agentSession); this.handles.set(execution.id, { session: execution.agentSession, handle }); }
    const active = this.handles.get(execution.id); if (!active) throw new Error("implementer session handle unavailable");
    const promptText = `Implement the frozen approved contract titled ${task.contract.title}. Acceptance criteria: ${JSON.stringify(task.contract.acceptanceCriteria)}. The task-owned frozen contract snapshot below is authoritative; do not access or edit original approval files or contract artifacts. Make the required changes only in the allowed worktree. Frozen contract snapshot:\n${await this.frozenContractContext(task.id)}\nFactory-owned prior evidence follows; address every reported failure without weakening the contract:\n${await this.repairContext(task.id, run.id)}`;
    let result: AgentTurnResult;
    try { result = await this.runControllerTurn(task, run, execution, active.handle, promptText); } catch (error) { result = { terminal: false, success: false, stopReason: "error", messageCount: 0, errorMessage: error instanceof Error ? error.message : String(error) }; }
    run = await this.loadRun(run.id);
    if (!result.success) { const nextCounters = incrementRetry(run.counters, "protocol"); if (!canRetry(run.counters, DEFAULT_RETRY_POLICY, "protocol")) return this.fail(attemptTask, { ...run, counters: nextCounters }, "protocol", result.errorMessage ?? "implementer turn failed"); const recovered = this.handles.get(execution.id); if (recovered) { try { await this.deps.agentRuntime.close(recovered.handle); } catch {} this.handles.delete(execution.id); } const resumed = await this.deps.agentRuntime.resumeSession(execution.agentSession); this.handles.set(execution.id, { session: execution.agentSession, handle: resumed }); const retriedRun = { ...run, counters: nextCounters, revision: run.revision + 1, updatedAt: this.now() }; await this.saveRun(retriedRun, run.revision); return { task, run: retriedRun, state: "advanced" }; }
    const nextRun = await this.moveRun(run, "verify"); const nextTask = transitionTask(attemptTask, "verifying"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
  }
  private async runControllerTurn(task: TcsfTask, run: TcsfRun, execution: ExecutionRecord, handle: AgentSessionHandle, prompt: string): Promise<AgentTurnResult> {
    const owner: WriterOwner = { type: "controller", controllerId: this.controllerId };
    let writerLease = await this.deps.executionHost.acquireWriter(execution.host, owner);
    const leased = { ...execution, status: "running" as const, writerLease, lastHeartbeatAt: this.now() };
    this.executions.set(execution.id, leased);
    await this.writeExecution(task.id, leased);
    await this.recordEvent(task.id, "lease_acquired", run.id, run.revision, execution.id);
    let renewalChain = Promise.resolve();
    let leaseLoss: Error | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let turnCompleted = false;
    const renew = (): void => {
      renewalChain = renewalChain.then(async () => {
        if (leaseLoss) return;
        try {
          if (this.deps.executionHost.renewWriter) writerLease = await this.deps.executionHost.renewWriter(writerLease);
          const latestRun = await this.loadRun(run.id);
          this.assertRunLease(latestRun);
          const renewedRun = await this.renewRunLease(latestRun);
          const current = this.executions.get(execution.id) ?? leased;
          const heartbeat = { ...current, writerLease, lastHeartbeatAt: this.now() };
          this.executions.set(execution.id, heartbeat);
          await this.writeExecution(task.id, heartbeat);
          if (renewedRun.revision !== latestRun.revision) await this.recordEvent(task.id, "lease_acquired", renewedRun.id, renewedRun.revision, execution.id);
        } catch (error) {
          leaseLoss = error instanceof Error ? error : new Error(String(error));
          const activeTurn = this.activeTurns.get(execution.id);
          if (activeTurn) await this.deps.agentRuntime.interruptTurn(activeTurn.handle, activeTurn.turn).catch(() => undefined);
        }
      }).catch(error => { leaseLoss = error instanceof Error ? error : new Error(String(error)); });
    };
    try {
      const metadata = execution.agentSession.metadata ?? {};
      const sequenceNumber = typeof metadata.lastTurnSequence === "number" ? metadata.lastTurnSequence + 1 : 1;
      const contentHash = await sha256Text(prompt);
      const logicalTurnId = `${execution.id}:${sequenceNumber}:${contentHash.slice(0, 16)}`;
      const deliveredPrompt = `${prompt}\n[TCSF logical-turn id=${logicalTurnId} content-hash=${contentHash}]`;
      await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/executions/turns/${logicalTurnId}.intent.json`, new TextEncoder().encode(`${JSON.stringify({ logicalTurnId, sequenceNumber, contentHash, prompt, deliveredPrompt, createdAt: this.now() })}\n`));
      const turn = await this.deps.agentRuntime.sendTurn(handle, { prompt, logicalTurnId, contentHash });
      const sent = { ...leased, agentSession: handle.ref, writerLease, activeTurnId: turn.turnId, activeTurnLogicalId: logicalTurnId, activeTurnContentHash: contentHash, activeTurnPrompt: deliveredPrompt };
      this.executions.set(execution.id, sent);
      await this.writeExecution(task.id, sent);
      await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/executions/turns/${logicalTurnId}.dispatch.json`, new TextEncoder().encode(`${JSON.stringify({ logicalTurnId, sequenceNumber, contentHash, sessionId: handle.ref.sessionId, turnId: turn.turnId, dispatchedAt: this.now() })}\n`));
      this.activeTurns.set(execution.id, { handle, turn });
      timer = setInterval(renew, this.deps.leaseRenewIntervalMs ?? 10_000);
      const result = await this.deps.agentRuntime.waitForTurn(handle, turn);
      if (leaseLoss) throw new Error(`lease renewal lost during turn: ${leaseLoss.message}`);
      this.activeTurns.delete(execution.id);
      await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/executions/turns/${logicalTurnId}.complete.json`, new TextEncoder().encode(`${JSON.stringify({ logicalTurnId, contentHash, ...turn, result, completedAt: this.now() })}\n`));
      turnCompleted = true;
      return result;
    } finally {
      if (timer) clearInterval(timer);
      await renewalChain;
      const current = this.executions.get(execution.id) ?? leased;
      this.activeTurns.delete(execution.id);
      await this.deps.executionHost.releaseWriter(writerLease);
      const released = { ...current, writerLease: undefined, activeTurnId: turnCompleted ? undefined : current.activeTurnId, activeTurnLogicalId: turnCompleted ? undefined : current.activeTurnLogicalId, activeTurnContentHash: turnCompleted ? undefined : current.activeTurnContentHash, activeTurnPrompt: turnCompleted ? undefined : current.activeTurnPrompt, lastTerminalTurnAt: turnCompleted ? this.now() : current.lastTerminalTurnAt };
      this.executions.set(execution.id, released);
      await this.writeExecution(task.id, released);
      await this.recordEvent(task.id, "lease_released", run.id, run.revision, execution.id);
    }
  }
  private async writeExecution(taskId: string, execution: ExecutionRecord): Promise<void> { await this.deps.artifacts.writeArtifact(taskId, `runs/${execution.runId}/executions/${execution.id}.json`, new TextEncoder().encode(`${JSON.stringify(execution, null, 2)}\n`)); }
  private async advanceVerification(task: TcsfTask, run: TcsfRun, signal?: AbortSignal): Promise<AdvanceResult> {
    const set = await this.workspaceFor(task, run); const workspace = [...set.workspaces.values()].find(item => item.role !== "reference"); if (!workspace?.worktreePath) throw new Error("no writable worktree");
    const changeSet = await this.deps.workspace.captureChanges(set); const unauthorizedRepos = [...changeSet.changes.values()].filter(change => !change.isAuthorized).map(change => change.repoKey); await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/integrity/change-set.json`, new TextEncoder().encode(`${JSON.stringify({ ...changeSet, changes: [...changeSet.changes.entries()] }, null, 2)}\n`));
    if (unauthorizedRepos.length > 0) { const restored = await this.deps.workspace.restoreUnauthorizedChanges({ workspaceSet: set, changeSet, unauthorizedRepos }); if (!restored.allSucceeded) return this.fail(task, run, "policy", "unauthorized workspace changes could not be restored"); return this.fail(task, run, "policy", "unauthorized workspace changes detected"); }
    const commands: VerificationCommand[] = task.contract.acceptanceCriteria.filter(criteria => criteria.verificationCommand).map(criteria => ({ id: criteria.id, name: criteria.description, shell: criteria.verificationCommand!, expectedExitCode: criteria.expectedExitCode, optional: false })); const result = await this.deps.verification.run({ taskId: task.id, cwd: workspace.worktreePath, commands, artifactDir: `${this.root()}/tasks/${task.id}/runs/${run.id}/verification`, signal });
    if (signal?.aborted) throw new StageLeaseLostError("verification controller lease was lost");
    const currentRun = await this.loadRun(run.id); this.assertRunLease(currentRun);
    await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/repair-context.json`, new TextEncoder().encode(`${JSON.stringify({ kind: "verification", result }, null, 2)}\n`)); await this.deps.failpoint?.pause("after_verification_before_stage_update", { taskId: task.id, runId: run.id });
    if (!result.passed) { const next = incrementRetry(currentRun.counters, "verification"); const retryPolicy = { ...DEFAULT_RETRY_POLICY, verificationRepairs: task.contract.policy.maxVerificationRetries ?? task.contract.policy.maxImplementationRetries }; if (!canRetry(currentRun.counters, retryPolicy, "verification")) return this.fail(task, { ...currentRun, counters: next }, "verification", "verification repair limit exhausted"); const nextRun = await this.moveRun({ ...currentRun, counters: next }, "implement"); const nextTask = transitionTask(task, "implementing"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" }; }
    const nextRun = await this.moveRun(currentRun, "review"); const nextTask = transitionTask(task, "reviewing"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
  }
  private async advanceReview(task: TcsfTask, run: TcsfRun, signal?: AbortSignal): Promise<AdvanceResult> {
    if (!this.deps.reviewer) return this.fail(task, run, "protocol", "reviewer adapter is not configured");
    const set = await this.workspaceFor(task, run); const workspace = [...set.workspaces.values()].find(item => item.role !== "reference");
    if (!workspace?.worktreePath) throw new Error("no writable worktree");
    const reviewerExecutionId = `${run.id}-reviewer`;
    const result = await this.deps.reviewer.review({ taskId: task.id, runId: run.id, reviewerExecutionId, sourceRevision: String(run.revision), signal, cwd: workspace.worktreePath, contractTitle: task.contract.title, contractSummary: JSON.stringify({ frozenContract: await this.frozenContractContext(task.id), contract: task.contract, factoryEvidence: await this.repairContext(task.id, run.id) }) });
    if (signal?.aborted) throw new StageLeaseLostError("review controller lease was lost");
    const currentRun = await this.loadRun(run.id); this.assertRunLease(currentRun);
    const priorRepairContext = await this.repairContext(task.id, run.id);
    await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/repair-context.json`, new TextEncoder().encode(`${JSON.stringify({ prior: priorRepairContext, review: result }, null, 2)}\n`));
    if (result.verdict === "decision_required") {
      const decision: DecisionRequest = { id: `${run.id}-review-decision-${currentRun.counters.reviewRepairs + 1}`, taskId: task.id, runId: run.id, category: "behavior_change", question: result.summary || "Reviewer requires a decision before continuing.", evidence: [{ taskId: task.id, relativePath: `runs/${run.id}/repair-context.json` }], options: [{ id: "resume-repair", label: "Resume repair", description: "Continue implementation with the review context.", consequences: "The implementer receives the finding and verification runs again." }, { id: "stop-run", label: "Stop run", description: "Stop this managed run without changing the approved contract.", consequences: "The task remains failed and requires a new approved run." }], recommendation: "resume-repair", consequenceOfDelay: "The run remains paused until an operator resolves this decision.", requestedAt: this.now(), resumeStage: "implement", status: "open" };
      await this.requestDecision(decision); const waitingTask = await this.deps.artifacts.loadTask(task.id); const waitingRun = await this.loadRun(run.id); return { task: waitingTask, run: waitingRun, state: "waiting" };
    }
    if (result.verdict === "fail" || result.findings.some(finding => finding.severity === "blocking")) {
      const nextCounters = incrementRetry(currentRun.counters, "semantic"); if (nextCounters.reviewRepairs > task.contract.policy.maxReviewRounds) return this.fail(task, { ...currentRun, counters: nextCounters }, "semantic", "review repair limit exhausted");
      const nextRun = await this.moveRun({ ...currentRun, counters: nextCounters }, "implement"); const nextTask = transitionTask(task, "implementing"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
    }
    const nextRun = await this.moveRun(currentRun, "candidate_validate"); const nextTask = transitionTask(task, "candidate_validating"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
  }
  private async advanceCandidate(task: TcsfTask, run: TcsfRun, signal?: AbortSignal): Promise<AdvanceResult> {
    const set = await this.workspaceFor(task, run); const workspace = [...set.workspaces.values()].find(item => item.role !== "reference");
    if (!workspace?.worktreePath) throw new Error("no writable worktree");
    let passed = true; let evidence = "ordinary candidate acceptance checks";
    if (isSelfChange(task.contract.repositories)) {
      const extensionPath = `${workspace.worktreePath}/dot_omp/private_agent/extensions/tcsf/index.ts`;
      if (!this.deps.candidateRuntime?.executePack) return this.fail(task, run, "candidate_validation", "self-development requires the complete candidate scenario pack");
      const candidate = await this.deps.candidateRuntime.executePack({ extensionPath, cwd: workspace.worktreePath, sessionDirectory: `${this.root()}/tasks/${task.id}/runs/${run.id}/candidate-runtime`, scenarioRoot: `${this.root()}/tasks/${task.id}/runs/${run.id}/candidate-validation/scenarios`, timeoutMs: 300_000 });
      passed = candidate.passed; evidence = JSON.stringify(candidate);
      await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/candidate-validation/pack.json`, new TextEncoder().encode(`${JSON.stringify(candidate, null, 2)}\n`));
    }
    const commands: VerificationCommand[] = task.contract.acceptanceCriteria.filter(criteria => criteria.verificationCommand).map(criteria => ({ id: criteria.id, name: criteria.description, shell: criteria.verificationCommand!, expectedExitCode: criteria.expectedExitCode, optional: false }));
    const result = await this.deps.verification.run({ taskId: task.id, cwd: workspace.worktreePath, commands, artifactDir: `${this.root()}/tasks/${task.id}/runs/${run.id}/candidate-validation`, signal });
    if (signal?.aborted) throw new StageLeaseLostError("candidate controller lease was lost");
    const currentRun = await this.loadRun(run.id); this.assertRunLease(currentRun);
    await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/candidate-validation/summary.json`, new TextEncoder().encode(`${JSON.stringify({ runtimePassed: passed, runtimeEvidence: evidence, verification: result }, null, 2)}\n`));
    if (!passed || !result.passed) {
      const counters = incrementRetry(currentRun.counters, "candidate_validation");
      if (counters.candidateValidationRepairs > task.contract.policy.maxCandidateValidationRounds) return this.fail(task, { ...currentRun, counters }, "candidate_validation", "candidate validation repair limit exhausted");
      const nextRun = await this.moveRun({ ...currentRun, counters }, "implement"); const nextTask = transitionTask(task, "implementing"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "advanced" };
    }
    const movedRun = await this.moveRun(currentRun, "ready_for_acceptance"); const nextRun = { ...movedRun, status: "terminal" as const, lease: undefined, revision: movedRun.revision + 1, updatedAt: this.now() };
    if (currentRun.activeExecutionId) { const execution = await this.loadExecution(currentRun.activeExecutionId); const active = this.handles.get(currentRun.activeExecutionId); if (active) { try { await this.deps.agentRuntime.close(active.handle); } finally { this.handles.delete(currentRun.activeExecutionId); } } if (execution) { try { await this.deps.executionHost.stop(execution.host, "graceful"); } finally { const succeeded = { ...execution, status: "succeeded" as const, writerLease: undefined, finishedAt: this.now() }; this.executions.set(execution.id, succeeded); await this.writeExecution(task.id, succeeded); await this.recordEvent(task.id, "execution_finished", currentRun.id, nextRun.revision, execution.id); } } }
    await this.deps.artifacts.saveRun(nextRun, movedRun.revision); const nextTask = transitionTask(task, "ready_for_acceptance"); const saved = await this.deps.artifacts.saveTask({ ...nextTask, activeRunId: nextRun.id }, task.revision); return { task: saved, run: nextRun, state: "terminal" };
  }
  private async withStageLease(task: TcsfTask, run: TcsfRun, stage: string, operation: (signal: AbortSignal) => Promise<AdvanceResult>): Promise<AdvanceResult> {
    const controller = new AbortController(); let loss: Error | undefined; let chain = Promise.resolve();
    const renew = (): void => {
      chain = chain.then(async () => {
        if (loss) return;
        try { const latest = await this.loadRun(run.id); this.assertRunLease(latest); await this.renewRunLease(latest); }
        catch (error) { loss = error instanceof Error ? error : new Error(String(error)); controller.abort(); try { await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/recovery/infrastructure-loss-${Date.now()}.json`, new TextEncoder().encode(`${JSON.stringify({ stage, controllerId: this.controllerId, error: loss.message, observedAt: this.now() }, null, 2)}\n`)); } catch {} }
      }).catch(error => { loss = error instanceof Error ? error : new Error(String(error)); controller.abort(); });
    };
    const timer = setInterval(renew, this.deps.leaseRenewIntervalMs ?? 10_000);
    try { const result = await operation(controller.signal); await chain; if (loss) throw new StageLeaseLostError(`run lease lost during ${stage}: ${loss.message}`); return result; }
    finally { clearInterval(timer); await chain; }
  }
  private async fail(task: TcsfTask, run: TcsfRun, failureClass: FailureClass, message: string): Promise<AdvanceResult> {
    if (run.status === "failed" || task.phase === "failed") return { task, run, state: "failed" };
    const failed = { ...run, status: "failed" as const, currentStage: "failed" as const, lease: undefined, revision: run.revision + 1, blocker: { category: failureClass, message, retryable: false, since: this.now() } };
    await this.saveRun(failed, run.revision);
    if (run.activeExecutionId) { try { const execution = await this.loadExecution(run.activeExecutionId); if (execution && !["failed", "cancelled", "succeeded"].includes(execution.status)) await this.writeExecution(task.id, { ...execution, status: "failed", writerLease: undefined, finishedAt: this.now(), failure: { failureClass, message, retryable: false, atTimestamp: this.now() } }); } catch {} }
    await this.deps.artifacts.writeArtifact(task.id, `runs/${run.id}/failure.json`, new TextEncoder().encode(`${JSON.stringify({ failureClass, message, at: failed.blocker.since }, null, 2)}\n`));
    const saved = await this.deps.artifacts.saveTask(transitionTask(task, "failed"), task.revision); return { task: saved, run: failed, state: "failed" };
  }
  private async moveRun(run: TcsfRun, currentStage: TcsfRun["currentStage"]): Promise<TcsfRun> { const next = { ...transitionRun(run, currentStage), updatedAt: this.now() }; await this.saveRun(next, run.revision); await this.recordEvent(run.taskId, "run_stage_changed", run.id, next.revision); return next; }
  private wallTimeExpired(task: TcsfTask, run: TcsfRun): boolean { const maxWallTimeMs = task.contract.policy.maxWallTimeHours * 60 * 60 * 1_000; return Number.isFinite(maxWallTimeMs) && maxWallTimeMs >= 0 && this.clock().getTime() - new Date(run.createdAt).getTime() > maxWallTimeMs; }
  private assertRunLease(run: TcsfRun): void { const lease = run.lease; if (!lease) throw new Error(`run ${run.id} has no active lease`); if (lease.holderId !== this.controllerId) throw new Error(`run ${run.id} is owned by ${lease.holderId}`); if (new Date(lease.acquiredAt).getTime() > this.clock().getTime() || new Date(lease.expiresAt).getTime() <= this.clock().getTime()) throw new Error(`run ${run.id} lease is expired or invalid`); if (this.deps.leaseToken && lease.token !== this.deps.leaseToken) throw new Error(`run ${run.id} lease token mismatch`); }
  private async renewRunLease(run: TcsfRun): Promise<TcsfRun> { if (!run.lease || new Date(run.lease.expiresAt).getTime() - this.clock().getTime() > 20_000) return run; this.assertRunLease(run); const renewed = { ...run, revision: run.revision + 1, updatedAt: this.now(), lease: { ...run.lease, expiresAt: new Date(this.clock().getTime() + 60_000).toISOString() } }; await this.saveRun(renewed, run.revision); return renewed; }
  private async saveRun(run: TcsfRun, expectedRevision: number | null): Promise<void> { await this.deps.artifacts.saveRun(run, expectedRevision); }
  private async loadRun(runId: string): Promise<TcsfRun> { const taskId = taskIdFromRunId(runId); return this.deps.artifacts.loadRun(taskId, runId); }
  private validatePacket(packet: ApprovedContractPacket): void { if (packet.schemaVersion !== 1 || !packet.taskId || !packet.title || !packet.approvalId || packet.repositories.length === 0 || !packet.artifacts.spec || !packet.artifacts.verification) throw new Error("invalid approved contract packet"); }
}

function taskIdFromRunId(runId: string): string { const marker = runId.lastIndexOf(RUN_SEPARATOR); if (marker <= 0) throw new Error(`invalid run id: ${runId}`); return runId.slice(0, marker); }
function isMissingArtifact(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}
function isIdempotentLeaseReleaseError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return true;
  return error instanceof Error && /\balready released\b/iu.test(error.message);
}
async function sha256Text(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }