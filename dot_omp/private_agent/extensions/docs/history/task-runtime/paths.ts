/**
 * Centralized path helpers for V2 task storage.
 *
 * Everything under `~/.omp/tasks/<id>/` must go through these helpers.
 * Direct string concatenation in command handlers / tools is a code smell.
 *
 * TASK_ROOT is a getter, NOT a module-level constant, because tests must be
 * able to redirect HOME per-test without re-importing this module. The
 * `~/.omp/tasks` path is always read at call time.
 */

import { resolve } from "node:path";

export const VALID_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]+$/;
export const MIN_TASK_ID_LENGTH = 2;

export function isValidTaskId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id.length < MIN_TASK_ID_LENGTH) return false;
  return VALID_TASK_ID.test(id);
}

export function assertValidTaskId(id: string): void {
  if (!isValidTaskId(id)) {
    throw new Error(
      `invalid task id "${id}": must match ${VALID_TASK_ID} and have at least ${MIN_TASK_ID_LENGTH} chars`,
    );
  }
}

function homeDir(): string {
  // Bun.env is the runtime's view; process.env is set by the OS.
  // Fall back to the empty string so we never silently write to "/".
  return Bun.env.HOME ?? process.env.HOME ?? "";
}

export function getTaskRoot(): string {
  return homeDir() + "/.omp/tasks";
}

export function taskRootDir(id: string): string {
  assertValidTaskId(id);
  return resolve(getTaskRoot(), id);
}

export function manifestPath(id: string): string {
  return resolve(taskRootDir(id), "manifest.json");
}

export function eventsPath(id: string): string {
  return resolve(taskRootDir(id), "events.jsonl");
}

export function artifactsDir(id: string): string {
  return resolve(taskRootDir(id), "artifacts");
}

export function specPath(id: string): string {
  return resolve(artifactsDir(id), "spec.md");
}

export function evidencePath(id: string): string {
  return resolve(artifactsDir(id), "evidence.md");
}

export function decisionsPath(id: string): string {
  return resolve(artifactsDir(id), "decisions.jsonl");
}

export function verificationPath(id: string): string {
  return resolve(artifactsDir(id), "verification.json");
}

export function snapshotsDir(id: string): string {
  return resolve(taskRootDir(id), "snapshots");
}

export function snapshotDir(id: string, approvalId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(approvalId) || approvalId.length === 0) {
    throw new Error(`invalid approval id "${approvalId}"`);
  }
  return resolve(snapshotsDir(id), approvalId);
}

export function snapshotSpecPath(id: string, approvalId: string): string {
  return resolve(snapshotDir(id, approvalId), "spec.md");
}

export function snapshotEvidencePath(id: string, approvalId: string): string {
  return resolve(snapshotDir(id, approvalId), "evidence.md");
}

export function snapshotDecisionsPath(id: string, approvalId: string): string {
  return resolve(snapshotDir(id, approvalId), "decisions.jsonl");
}

export function snapshotVerificationPath(id: string, approvalId: string): string {
  return resolve(snapshotDir(id, approvalId), "verification.json");
}

export function snapshotHandoffPath(id: string, approvalId: string): string {
  return resolve(snapshotDir(id, approvalId), "handoff.json");
}

export function worktreesDir(id: string): string {
  return resolve(taskRootDir(id), "worktrees");
}

export function worktreePath(id: string, repoName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName.length === 0) {
    throw new Error(`invalid repo name "${repoName}"`);
  }
  if (repoName === "." || repoName === "..") {
    throw new Error(`invalid repo name "${repoName}"`);
  }
  return resolve(worktreesDir(id), repoName);
}

/**
 * Confirm that `child` is contained inside `parent`. Defends against
 * accidental escapes when callers pass user-influenced path fragments.
 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  return c.startsWith(p + "/");
}

/**
 * Resolve any filesystem path to a canonical form, rejecting traversal
 * sequences that would escape the task root.
 */
export function safeResolve(root: string, candidate: string): string {
  const r = resolve(root);
  const c = resolve(candidate);
  if (!isInside(r, c) && c !== r) {
    throw new Error(`path "${candidate}" escapes root "${root}"`);
  }
  return c;
}
