/**
 * Task Factory V2 — semantic types.
 *
 * Mirrors `TaskManifestV2` from the implementation spec (section 8).
 * Field names are normative: deviating from them requires the new name to
 * encode the same semantic distinction, otherwise tools/state code will not
 * recognize the field.
 */

export type TaskType = "feat" | "fix" | "chore" | "refactor" | "test";


export const SCHEMA_VERSION = 2 as const;

/** argv-based shell exec; mirrors pi.exec shape used by tools. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export type TaskPhase =
  | "discovery"
  | "ready_for_approval"
  | "approved"
  | "implementing"
  | "blocked"
  | "completed"
  | "failed";

export type RepoRole = "primary" | "target" | "reference";

export interface RepoEntry {
  name: string;
  role: RepoRole;
  sourcePath: string;
  baseSha?: string;
  branch?: string;
  worktreePath?: string;
}

export interface SessionBinding {
  sessionFile: string;
  role: "cracker" | "implementer";
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  createdAt: string;
  snapshotPath: string;
  specSha256: string;
  evidenceSha256: string;
  decisionsSha256: string;
  verificationSha256: string;
}

export interface BlockerRecord {
  reason: string;
  createdAt: string;
}

export interface TaskManifestV2 {
  schemaVersion: 2;
  id: string;
  type: TaskType;
  phase: TaskPhase;
  description?: string;
  primaryRepo: string;
  repos: Record<string, RepoEntry>;
  sessions: {
    cracker?: SessionBinding;
    implementer?: SessionBinding;
  };
  approval?: ApprovalRecord;
  blocker?: BlockerRecord;
  createdAt: string;
  updatedAt: string;
}

export type DecisionRecord =
  | {
      op: "open";
      id: string;
      question: string;
      dependsOn: string[];
      options: string[];
      recommendation?: string;
      reason?: string;
      at: string;
    }
  | {
      op: "resolve";
      id: string;
      answer: string;
      source: "user" | "system";
      at: string;
    };

export interface OpenDecision {
  id: string;
  question: string;
  dependsOn: string[];
  options: string[];
  recommendation?: string;
  reason?: string;
  openedAt: string;
}

export interface ResolvedDecision {
  id: string;
  answer: string;
  source: "user" | "system";
  resolvedAt: string;
  question: string;
}

export interface VerificationCheck {
  id: string;
  repo: string;
  command: string;
  required: boolean;
}

export interface VerificationContract {
  checks: VerificationCheck[];
  manualReason?: string;
}

export type CheckOutcomeStatus = "pass" | "fail" | "error";

export interface CheckOutcome {
  id: string;
  command: string;
  repo: string;
  required: boolean;
  status: CheckOutcomeStatus;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
}

export interface VerificationRunResult {
  startedAt: string;
  finishedAt: string;
  requiredFailures: string[];
  optionalFailures: string[];
  outcomes: CheckOutcome[];
  manualOnly: boolean;
}

export type RuntimeEventType =
  | "task_created"
  | "repo_attached"
  | "decision_opened"
  | "decision_resolved"
  | "artifact_written"
  | "verification_defined"
  | "ready_for_approval"
  | "approval_created"
  | "worktree_created"
  | "implementation_session_started"
  | "policy_violation"
  | "verification_started"
  | "verification_check_finished"
  | "implementation_blocked"
  | "task_completed";

export interface RuntimeEvent {
  type: RuntimeEventType;
  at: string;
  taskId: string;
  [k: string]: unknown;
}

export interface TaskArtifactPaths {
  root: string;
  manifest: string;
  events: string;
  artifacts: string;
  snapshots: string;
  worktrees: string;
  spec: string;
  evidence: string;
  decisions: string;
  verification: string;
}

export type SubmitOutcome =
  | { kind: "completed"; verification: VerificationRunResult; diffSummary: DiffSummary[] }
  | { kind: "still_implementing"; reason: string; verification?: VerificationRunResult; diffSummary?: DiffSummary[] }
  | { kind: "blocked_manual"; reason: string; verification?: VerificationRunResult; diffSummary?: DiffSummary[] }
  | { kind: "error"; reason: string };

export interface DiffSummary {
  repo: string;
  changedFileCount: number;
  insertions: number;
  deletions: number;
  isEmpty: boolean;
}

export interface ReadinessIssue {
  code: string;
  message: string;
}

export type ReadinessResult =
  | { ok: true }
  | { ok: false; issues: ReadinessIssue[] };

/** SHA-256 hex digest (lowercase, 64 chars). */
export type Sha256Hex = string;
