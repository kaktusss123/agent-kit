/**
 * Task Runtime lifecycle — the single source of truth for state changes.
 *
 * Both slash commands and model-callable tools call these functions.
 * No phase mutation happens anywhere else.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  artifactsDir,
  isValidTaskId,
  taskRootDir,
  decisionsPath,
  evidencePath,
  specPath,
  verificationPath,
  worktreePath,
} from "./paths.ts";
import {
  LegacyTaskError,
  loadManifest,
  saveManifest,
} from "./storage.ts";
import type { ExecFn } from "./types.ts";
import {
  applyTransition,
  assertPhase,
  type Transition,
} from "./state.ts";
import {
  appendOpen,
  appendResolve,
  getOpenDecisions,
} from "./decisions.ts";
import {
  attachRepo as attachRepoPure,
  createWorktree,
  diffSummaryAgainst,
  isRepoClean,
  isWorkingTreeClean,
  repoHeadSha,
} from "./repos.ts";
import {
  buildSnapshot,
  newApprovalId,
  readHandoff,
  validateSnapshot,
  writeHandoff,
  type HandoffDoc,
} from "./snapshots.ts";
import {
  loadAndValidateContract,
  readVerificationContract,
  runContract,
  validateContractAgainstRepos,
} from "./verification.ts";
import {
  decisionOpened,
  decisionResolved,
  artifactWritten,
  approvalCreated,
  implementationBlocked,
  readyForApproval,
  repoAttached,
  taskCompleted,
  taskCreated,
  verificationCheckFinished,
  verificationDefined,
  verificationStarted,
  worktreeCreated,
} from "./events.ts";
import type {
  ApprovalRecord,
  DiffSummary,
  ReadinessIssue,
  ReadinessResult,
  RepoRole,
  SubmitOutcome,
  TaskManifestV2,
  TaskType,
  VerificationCheck,
  VerificationContract,
} from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface CreateTaskInput {
  id: string;
  type: TaskType;
  description?: string;
  /** git top-level for the primary repo; cwd-derived input. */
  primarySourcePath: string;
  /** session file to bind as cracker (from ctx.sessionManager.getSessionFile()). */
  crackerSessionFile: string | undefined;
  exec: ExecFn;
}

export async function createTask(input: CreateTaskInput): Promise<TaskManifestV2> {
  if (!isValidTaskId(input.id)) {
    throw new LifecycleError(`invalid task id "${input.id}"`);
  }
  const root = taskRootDir(input.id);
  if (existsSync(root)) {
    throw new LifecycleError(`task "${input.id}" already exists at ${root}`);
  }
  if (!input.crackerSessionFile) {
    throw new LifecycleError("cracker session file is required to create a task");
  }

  const primaryCanonical = await resolveGitTopLevel(input.exec, input.primarySourcePath);
  const primaryName = primaryCanonical.split("/").filter(Boolean).pop() ?? primaryCanonical;
  const now = new Date().toISOString();

  // §1: capture HEAD and create a clean detached task worktree at init time.
  // The user's source checkout may be arbitrarily dirty — task workspace is clean.
  const baseSha = await repoHeadSha(input.exec, primaryCanonical);
  const wtDir = worktreePath(input.id, primaryName);
  await createWorktree(input.exec, {
    repoPath: primaryCanonical,
    worktreeDir: wtDir,
    baseSha,
  });
  await worktreeCreated(input.id, primaryName, "", baseSha);

  const manifest: TaskManifestV2 = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    type: input.type,
    phase: "discovery",
    primaryRepo: primaryName,
    ...(input.description ? { description: input.description } : {}),
    repos: {
      [primaryName]: {
        name: primaryName,
        role: "primary",
        sourcePath: primaryCanonical,
        worktreePath: wtDir,
        baseSha,
      },
    },
    sessions: {
      cracker: {
        sessionFile: input.crackerSessionFile,
        role: "cracker",
        createdAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  };

  await mkdir(artifactsDir(input.id), { recursive: true });
  // Create empty decisions.jsonl so buildSnapshot can always find it.
  if (!existsSync(decisionsPath(input.id))) await Bun.write(decisionsPath(input.id), "");
  await saveManifest(manifest);
  await taskCreated(manifest);
  return manifest;
}

export async function attachRepoToTask(input: AttachRepoInput): Promise<TaskManifestV2> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "discovery", "ready_for_approval");
  const existing = Object.values(manifest.repos);
  const entry = await attachRepoPure(input.exec, { existing, rawPath: input.rawPath, role: input.role });
  // §3: all roles receive a clean detached task worktree
  entry.baseSha = await repoHeadSha(input.exec, entry.sourcePath);
  const wtDir = worktreePath(input.taskId, entry.name);
  await createWorktree(input.exec, { repoPath: entry.sourcePath, worktreeDir: wtDir, baseSha: entry.baseSha });
  entry.worktreePath = wtDir;
  manifest.repos[entry.name] = entry;
  manifest.updatedAt = new Date().toISOString();
  if (manifest.phase === "ready_for_approval") applyTransition(manifest, "ready_to_discovery");
  await saveManifest(manifest);
  await repoAttached(manifest, entry.name, entry.role);
  return manifest;
}

export interface WriteArtifactInput {
  taskId: string;
  kind: "spec" | "evidence";
  content: string;
}

export async function writeArtifact(input: WriteArtifactInput): Promise<TaskManifestV2> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "discovery", "ready_for_approval");
  const p = input.kind === "spec" ? specPath(input.taskId) : evidencePath(input.taskId);
  await mkdir(dirname(p), { recursive: true });
  await Bun.write(p, input.content);
  if (manifest.phase === "ready_for_approval") {
    applyTransition(manifest, "ready_to_discovery");
  }
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await artifactWritten(input.taskId, input.kind);
  return manifest;
}

export interface RecordDecisionInput {
  taskId: string;
  action: "open" | "resolve";
  decisionId: string;
  question?: string;
  dependsOn?: string[];
  options?: string[];
  recommendation?: string;
  reason?: string;
  answer?: string;
}

export async function recordDecision(input: RecordDecisionInput): Promise<TaskManifestV2> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "discovery", "ready_for_approval");
  if (input.action === "open") {
    if (!input.question) throw new LifecycleError("decision.open requires question");
    if (!input.options || input.options.length === 0) {
      throw new LifecycleError("decision.open requires options[]");
    }
    await appendOpen(input.taskId, {
      id: input.decisionId,
      question: input.question,
      dependsOn: input.dependsOn ?? [],
      options: input.options,
      ...(input.recommendation ? { recommendation: input.recommendation } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await decisionOpened(input.taskId, input.decisionId, input.question);
  } else {
    if (!input.answer) throw new LifecycleError("decision.resolve requires answer");
    await appendResolve(input.taskId, {
      id: input.decisionId,
      answer: input.answer,
      source: "user",
    });
    await decisionResolved(input.taskId, input.decisionId, input.answer);
  }
  if (manifest.phase === "ready_for_approval") {
    applyTransition(manifest, "ready_to_discovery");
  }
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  return manifest;
}

export interface SetVerificationInput {
  taskId: string;
  checks: VerificationCheck[];
  manualReason?: string;
}

export async function setVerification(input: SetVerificationInput): Promise<TaskManifestV2> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "discovery", "ready_for_approval");
  const seen = new Set<string>();
  for (const c of input.checks) {
    if (seen.has(c.id)) throw new LifecycleError(`duplicate check id "${c.id}"`);
    seen.add(c.id);
    if (!manifest.repos[c.repo]) {
      throw new LifecycleError(`verification check "${c.id}" references unknown repo "${c.repo}"`);
    }
    if (manifest.repos[c.repo].role === "reference") {
      throw new LifecycleError(`verification check "${c.id}" references reference repo "${c.repo}"`);
    }
  }
  if (input.checks.length === 0 && (!input.manualReason || input.manualReason.trim() === "")) {
    throw new LifecycleError("verification contract must have checks or a non-empty manualReason");
  }
  const contract: VerificationContract = {
    checks: input.checks,
    ...(input.manualReason ? { manualReason: input.manualReason.trim() } : {}),
  };
  await mkdir(dirname(verificationPath(input.taskId)), { recursive: true });
  await Bun.write(verificationPath(input.taskId), JSON.stringify(contract, null, 2) + "\n");
  if (manifest.phase === "ready_for_approval") {
    applyTransition(manifest, "ready_to_discovery");
  }
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await verificationDefined(input.taskId, input.checks.length, !!input.manualReason);
  return manifest;
}

export async function validateReadiness(taskId: string, exec?: import("./types.ts").ExecFn): Promise<ReadinessResult> {
  const issues: ReadinessIssue[] = [];
  let manifest: TaskManifestV2;
  try {
    manifest = await loadManifest(taskId);
  } catch (e) {
    if (e instanceof LegacyTaskError) {
      return { ok: false, issues: [{ code: "legacy", message: e.message }] };
    }
    throw e;
  }
  if (manifest.phase !== "discovery" && manifest.phase !== "ready_for_approval") {
    issues.push({ code: "phase", message: `task is in phase "${manifest.phase}"` });
  }
  const primary = manifest.repos[manifest.primaryRepo];
  if (!primary) {
    issues.push({ code: "primary_missing", message: `primary repo "${manifest.primaryRepo}" is not registered` });
  } else if (!existsSync(primary.sourcePath)) {
    issues.push({ code: "primary_path_missing", message: `primary source path ${primary.sourcePath} no longer exists` });
  }

  if (!existsSync(specPath(taskId)) || (await Bun.file(specPath(taskId)).text()).trim() === "") {
    issues.push({ code: "spec_empty", message: "spec.md is missing or empty" });
  }
  if (!existsSync(evidencePath(taskId)) || (await Bun.file(evidencePath(taskId)).text()).trim() === "") {
    issues.push({ code: "evidence_empty", message: "evidence.md is missing or empty" });
  }

  let openCount = 0;
  try {
    const open = await getOpenDecisions(taskId);
    openCount = open.length;
    if (openCount > 0) {
      issues.push({
        code: "open_decisions",
        message: `${openCount} open decision(s): ${open.map(d => d.id).join(", ")}`,
      });
    }
  } catch (e) {
    issues.push({ code: "decisions_malformed", message: (e as Error).message });
  }

  for (const [name, repo] of Object.entries(manifest.repos)) {
    if (!existsSync(repo.sourcePath)) {
      issues.push({
        code: "repo_path_missing",
        message: `repo "${name}" source path ${repo.sourcePath} no longer exists`,
      });
    }
  }

  // P2: worktree cleanliness check (cracker must not mutate product code).
  if (exec) {
    for (const [name, repo] of Object.entries(manifest.repos)) {
      if (!repo.worktreePath) continue;
      try {
        const clean = await isWorkingTreeClean(exec, repo.worktreePath);
        if (!clean) {
          const stat = await exec("git", ["-C", repo.worktreePath, "diff-index", "--name-only", "HEAD"]);
          issues.push({
            code: "worktree_modified",
            message: `task worktree "${name}" (${repo.worktreePath}) has uncommitted changes: ${stat.stdout.trim() || "(tracked changes)"}`,
          });
        }
      } catch { issues.push({ code: "worktree_check_failed", message: `git status failed in "${name}" (${repo.worktreePath})` }); }
    }
  }

  try {
    const contract = readVerificationContract(taskId);
    const v = validateContractAgainstRepos(contract, manifest);
    if (!v.ok) {
      issues.push({ code: "verification_invalid", message: v.reason });
    }
  } catch (e) {
    issues.push({ code: "verification_malformed", message: (e as Error).message });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface MarkReadyResult {
  manifest: TaskManifestV2;
  readiness: ReadinessResult;
}

export async function markReady(taskId: string, exec?: import("./types.ts").ExecFn): Promise<MarkReadyResult> {
  const manifest = await loadManifest(taskId);
  assertPhase(manifest, "discovery", "ready_for_approval");
  const r = await validateReadiness(taskId, exec);
  if (!r.ok) return { manifest, readiness: r };
  applyTransition(manifest, "discovery_to_ready");
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await readyForApproval(taskId);
  return { manifest, readiness: { ok: true } };
}

export interface ApproveInput {
  taskId: string;
  exec: ExecFn;
}

export interface ApproveResult {
  manifest: TaskManifestV2;
  approval: ApprovalRecord;
}

export async function approveTask(input: ApproveInput): Promise<ApproveResult> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "ready_for_approval");
  const r = await validateReadiness(input.taskId, input.exec);
  if (!r.ok) {
    throw new LifecycleError(
      `approval refused: ${r.issues.map(i => `[${i.code}] ${i.message}`).join("; ")}`,
    );
  }
  const approvalId = newApprovalId();
  const { record } = await buildSnapshot(input.taskId, approvalId);
  manifest.approval = record;
  applyTransition(manifest, "ready_to_approved");
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await approvalCreated(input.taskId, approvalId, record.snapshotPath);
  return { manifest, approval: record };
}

export interface PrepareWorktreesInput {
  taskId: string;
  exec: ExecFn;
}

export interface PrepareWorktreesResult {
  manifest: TaskManifestV2;
  createdRepos: string[];
  reusedRepos: string[];
}

export async function prepareWorktrees(input: PrepareWorktreesInput): Promise<PrepareWorktreesResult> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "approved");
  if (!manifest.approval) {
    throw new LifecycleError("approval record missing on approved task");
  }

  const branch = `${manifest.type}/${manifest.id}`;
  const createdRepos: string[] = [];
  const reusedRepos: string[] = [];

  for (const [name, repo] of Object.entries(manifest.repos)) {
    if (repo.role === "reference") continue;

    // Worktrees must already exist from task_init / task_add_repo.
    if (!repo.worktreePath || !repo.baseSha) {
      throw new LifecycleError(
        `repo "${name}" has no task worktree — re-run /task_handoff after worktree creation`
      );
    }
    const wtDir = worktreePath(input.taskId, name);
    if (wtDir !== repo.worktreePath) {
      throw new LifecycleError(
        `repo "${name}" worktree path mismatch: recorded ${repo.worktreePath}, expected ${wtDir}`
      );
    }
    if (!existsSync(wtDir)) {
      throw new LifecycleError(
        `repo "${name}" worktree missing at ${wtDir} — re-run /task_init or /task_add_repo`
      );
    }

    const wtSha = await repoHeadSha(input.exec, wtDir);
    if (wtSha !== repo.baseSha) {
      throw new LifecycleError(
        `repo "${name}" worktree HEAD (${wtSha}) != recorded baseSha (${repo.baseSha})`
      );
    }

    // Validate worktree is clean before creating branch.
    const dirty = await isRepoClean(input.exec, wtDir);
    if (!dirty.clean) {
      throw new LifecycleError(
        `repo "${name}" task worktree is dirty before handoff — cracker must not modify product files. Dirty files:\n${dirty.summary}`
      );
    }

    // Switch detached HEAD to a feature branch.
    const checkoutR = await input.exec(
      "git",
      ["-C", wtDir, "checkout", "-b", branch, repo.baseSha]
    );
    if (checkoutR.code !== 0) {
      throw new LifecycleError(
        `failed to create branch "${branch}" in worktree "${wtDir}": ${checkoutR.stderr || checkoutR.stdout}`
      );
    }

    repo.branch = branch;
    createdRepos.push(name);
    await worktreeCreated(input.taskId, name, branch, repo.baseSha);

    manifest.updatedAt = new Date().toISOString();
    await saveManifest(manifest);
  }
  return { manifest, createdRepos, reusedRepos };
}

export interface BuildHandoffInput {
  taskId: string;
  approvalId: string;
}

export async function buildHandoff(input: BuildHandoffInput): Promise<HandoffDoc> {
  const manifest = await loadManifest(input.taskId);
  if (!manifest.approval || manifest.approval.id !== input.approvalId) {
    throw new LifecycleError(`approval "${input.approvalId}" not current on task "${input.taskId}"`);
  }
  const snapDir = manifest.approval.snapshotPath;
  const doc: Omit<HandoffDoc, "schemaVersion"> = {
    taskId: input.taskId,
    type: manifest.type,
    approvalId: input.approvalId,
    snapshot: {
      specPath: resolve(snapDir, "spec.md"),
      evidencePath: resolve(snapDir, "evidence.md"),
      decisionsPath: resolve(snapDir, "decisions.jsonl"),
      verificationPath: resolve(snapDir, "verification.json"),
    },
    repos: {},
  };
  for (const [name, repo] of Object.entries(manifest.repos)) {
    doc.repos[name] = {
      role: repo.role,
      sourcePath: repo.sourcePath,
      ...(repo.worktreePath ? { worktreePath: repo.worktreePath } : {}),
      ...(repo.baseSha ? { baseSha: repo.baseSha } : {}),
    };
  }
  await writeHandoff(input.taskId, input.approvalId, doc);
  return readHandoff(input.taskId, input.approvalId);
}

export interface StartImplementationInput {
  taskId: string;
  approvalId: string;
  /** Session file of the implementer (from the new session's sessionManager). */
  implementerSessionFile: string;
  exec: ExecFn;
}

export interface StartImplementationResult {
  manifest: TaskManifestV2;
  diffs: DiffSummary[];
}

export async function startImplementation(
  input: StartImplementationInput,
): Promise<StartImplementationResult> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "approved");
  if (!manifest.approval || manifest.approval.id !== input.approvalId) {
    throw new LifecycleError(`approval "${input.approvalId}" not current on task "${input.taskId}"`);
  }
  manifest.sessions.implementer = {
    sessionFile: input.implementerSessionFile,
    role: "implementer",
    createdAt: new Date().toISOString(),
  };
  applyTransition(manifest, "approved_to_implementing");
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  return { manifest, diffs: [] };
}

export interface PreflightResult {
  manifest: TaskManifestV2;
  verification: VerificationContract;
  diffs: DiffSummary[];
  policyVerdict: "ok" | "dirty_protected_repo";
}

export async function preflightSubmit(
  taskId: string,
  exec: ExecFn,
): Promise<PreflightResult> {
  const manifest = await loadManifest(taskId);
  assertPhase(manifest, "implementing");
  if (!manifest.approval) throw new LifecycleError("approval missing on implementing task");

  const v = await validateSnapshot(taskId, manifest.approval);
  if (!v.valid) {
    throw new LifecycleError(`approval snapshot is no longer valid: ${v.mismatches.join("; ")}`);
  }

  for (const [name, repo] of Object.entries(manifest.repos)) {
    if (!existsSync(repo.sourcePath)) {
      throw new LifecycleError(`repo "${name}" source path ${repo.sourcePath} disappeared`);
    }
  }

  let policyVerdict: "ok" | "dirty_protected_repo" = "ok";
  for (const [, repo] of Object.entries(manifest.repos)) {
    const dirty = await isRepoClean(exec, repo.sourcePath);
    if (!dirty.clean) {
      policyVerdict = "dirty_protected_repo";
      break;
    }
  }

  const diffs: DiffSummary[] = [];
  for (const [name, repo] of Object.entries(manifest.repos)) {
    if (repo.role === "reference") continue;
    if (!repo.worktreePath || !repo.baseSha) continue;
    const d = await diffSummaryAgainst(exec, repo.worktreePath, repo.baseSha);
    diffs.push({
      repo: name,
      changedFileCount: d.files,
      insertions: d.insertions,
      deletions: d.deletions,
      isEmpty: d.files === 0,
    });
  }

  const verification = loadAndValidateContract(taskId, manifest);
  return { manifest, verification, diffs, policyVerdict };
}

export interface SubmitImplementationInput {
  taskId: string;
  exec: ExecFn;
}

export async function submitImplementation(
  input: SubmitImplementationInput,
): Promise<SubmitOutcome> {
  let pre: PreflightResult;
  try {
    pre = await preflightSubmit(input.taskId, input.exec);
  } catch (e) {
    return { kind: "error", reason: (e as Error).message };
  }

  const { manifest, verification, diffs, policyVerdict } = pre;

  if (policyVerdict !== "ok") {
    return {
      kind: "still_implementing",
      reason:
        "protected repository was modified outside the worktree — refusing to complete. " +
        "Restore protected repos to their handoff state and try again.",
      diffSummary: diffs,
    };
  }

  if (verification.checks.length === 0 && !!verification.manualReason) {
    return {
      kind: "blocked_manual",
      reason:
        verification.manualReason ??
        "no deterministic verification checks defined; manual verification required",
      diffSummary: diffs,
    };
  }

  await verificationStarted(input.taskId, verification.checks.length);
  const result = await runContract(input.exec, verification, manifest);
  for (const o of result.outcomes) {
    await verificationCheckFinished(input.taskId, o.id, o.status, o.exitCode);
  }

  if (result.requiredFailures.length > 0) {
    return {
      kind: "still_implementing",
      reason: `required verification checks failed: ${result.requiredFailures.join(", ")}`,
      verification: result,
      diffSummary: diffs,
    };
  }

  const allDiffsEmpty = diffs.every(d => d.isEmpty);
  if (allDiffsEmpty) {
    return {
      kind: "still_implementing",
      reason: "no implementation changes detected",
      verification: result,
      diffSummary: diffs,
    };
  }

  applyTransition(manifest, "implementing_to_completed");
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await taskCompleted(input.taskId);
  return { kind: "completed", verification: result, diffSummary: diffs };
}

export interface BlockInput {
  taskId: string;
  reason: string;
}

export async function blockTask(input: BlockInput): Promise<TaskManifestV2> {
  const manifest = await loadManifest(input.taskId);
  assertPhase(manifest, "implementing");
  manifest.blocker = { reason: input.reason, createdAt: new Date().toISOString() };
  applyTransition(manifest, "implementing_to_blocked");
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  await implementationBlocked(input.taskId, input.reason);
  return manifest;
}

export async function resumeFromBlock(taskId: string): Promise<TaskManifestV2> {
  const manifest = await loadManifest(taskId);
  assertPhase(manifest, "blocked");
  applyTransition(manifest, "blocked_to_implementing");
  manifest.blocker = undefined;
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  return manifest;
}

export async function reopenTask(taskId: string): Promise<TaskManifestV2> {
  const manifest = await loadManifest(taskId);
  assertPhase(manifest, "approved", "implementing", "blocked");
  const t: Transition =
    manifest.phase === "approved" ? "approved_to_discovery" : "blocked_to_discovery";
  applyTransition(manifest, t);
  manifest.approval = undefined;
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);
  return manifest;
}

export interface TaskStatus {
  id: string;
  type: string;
  phase: string;
  primaryRepo: string;
  description?: string;
  repos: Array<{
    name: string;
    role: string;
    sourcePath: string;
    worktreePath?: string;
    baseSha?: string;
    branch?: string;
  }>;
  openDecisions: number;
  approval: { id: string; createdAt: string } | null;
  sessions: { cracker?: string; implementer?: string };
  blocker?: { reason: string; createdAt: string };
  createdAt: string;
  updatedAt: string;
}

export async function taskStatus(taskId: string): Promise<TaskStatus> {
  const manifest = await loadManifest(taskId);
  const open = await getOpenDecisions(taskId).catch(() => []);
  return {
    id: manifest.id,
    type: manifest.type,
    phase: manifest.phase,
    primaryRepo: manifest.primaryRepo,
    ...(manifest.description ? { description: manifest.description } : {}),
    repos: Object.values(manifest.repos).map(r => ({
      name: r.name,
      role: r.role,
      sourcePath: r.sourcePath,
      ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}),
      ...(r.baseSha ? { baseSha: r.baseSha } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
    })),
    openDecisions: open.length,
    approval: manifest.approval
      ? { id: manifest.approval.id, createdAt: manifest.approval.createdAt }
      : null,
    sessions: {
      ...(manifest.sessions.cracker?.sessionFile
        ? { cracker: manifest.sessions.cracker.sessionFile }
        : {}),
      ...(manifest.sessions.implementer?.sessionFile
        ? { implementer: manifest.sessions.implementer.sessionFile }
        : {}),
    },
    ...(manifest.blocker ? { blocker: manifest.blocker } : {}),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

async function resolveGitTopLevel(exec: ExecFn, p: string): Promise<string> {
  const r = await exec("git", ["-C", p, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) {
    throw new LifecycleError(`not a git repo: ${p}`);
  }
  return resolve(r.stdout.trim());
}

export { applyTransition, assertPhase };
export type { Transition };
