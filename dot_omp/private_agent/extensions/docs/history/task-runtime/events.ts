/**
 * Append-only event helper.
 *
 * Every significant runtime operation calls `recordEvent(...)` so that
 * `events.jsonl` stays a cheap, queryable trace. The manifest remains the
 * source of truth for current state; events describe history.
 */

import { appendEvent } from "./storage.ts";
import type { RuntimeEvent, RuntimeEventType, TaskManifestV2 } from "./types.ts";

export async function recordEvent(
  taskId: string,
  type: RuntimeEventType,
  fields: Record<string, unknown> = {},
): Promise<RuntimeEvent> {
  const ev: RuntimeEvent = {
    type,
    at: new Date().toISOString(),
    taskId,
    ...fields,
  };
  await appendEvent(ev);
  return ev;
}

export async function taskCreated(manifest: TaskManifestV2): Promise<void> {
  await recordEvent(manifest.id, "task_created", {
    type: manifest.type,
    primaryRepo: manifest.primaryRepo,
  });
}

export async function repoAttached(
  manifest: TaskManifestV2,
  repoName: string,
  role: string,
): Promise<void> {
  await recordEvent(manifest.id, "repo_attached", { repo: repoName, role });
}

export async function decisionOpened(
  taskId: string,
  decisionId: string,
  question: string,
): Promise<void> {
  await recordEvent(taskId, "decision_opened", { id: decisionId, question });
}

export async function decisionResolved(
  taskId: string,
  decisionId: string,
  answer: string,
): Promise<void> {
  await recordEvent(taskId, "decision_resolved", { id: decisionId, answer });
}

export async function artifactWritten(
  taskId: string,
  kind: "spec" | "evidence" | "verification",
): Promise<void> {
  await recordEvent(taskId, "artifact_written", { kind });
}

export async function verificationDefined(taskId: string, checks: number, manual: boolean): Promise<void> {
  await recordEvent(taskId, "verification_defined", { checks, manual });
}

export async function readyForApproval(taskId: string): Promise<void> {
  await recordEvent(taskId, "ready_for_approval");
}

export async function approvalCreated(
  taskId: string,
  approvalId: string,
  snapshotPath: string,
): Promise<void> {
  await recordEvent(taskId, "approval_created", { approval: approvalId, snapshotPath });
}

export async function worktreeCreated(
  taskId: string,
  repoName: string,
  branch: string,
  sha: string,
): Promise<void> {
  await recordEvent(taskId, "worktree_created", { repo: repoName, branch, sha });
}

export async function implementationSessionStarted(
  taskId: string,
  sessionFile: string,
): Promise<void> {
  await recordEvent(taskId, "implementation_session_started", { session: sessionFile });
}

export async function policyViolation(
  taskId: string,
  toolCallId: string,
  reason: string,
): Promise<void> {
  await recordEvent(taskId, "policy_violation", { toolCallId, reason });
}

export async function verificationStarted(taskId: string, checkCount: number): Promise<void> {
  await recordEvent(taskId, "verification_started", { checkCount });
}

export async function verificationCheckFinished(
  taskId: string,
  checkId: string,
  status: string,
  exitCode: number | null,
): Promise<void> {
  await recordEvent(taskId, "verification_check_finished", {
    check: checkId,
    status,
    exitCode,
  });
}

export async function implementationBlocked(taskId: string, reason: string): Promise<void> {
  await recordEvent(taskId, "implementation_blocked", { reason });
}

export async function taskCompleted(taskId: string): Promise<void> {
  await recordEvent(taskId, "task_completed");
}
