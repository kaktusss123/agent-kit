/**
 * TCSF Core Domain Types
 * 
 * Serializable domain types for task/run/execution state.
 * No OMP/Git/Bun/FS-specific imports - pure domain model.
 */

// ============================================================================
// Agent Runtime References
// ============================================================================

/**
 * Serializable reference to an agent session.
 * Opaque to core code - adapters know the internal structure.
 */
export interface AgentSessionRef {
  readonly kind: string;
  readonly sessionId: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Handle to an active agent session for sending turns.
 */
export interface AgentSessionHandle {
  readonly ref: AgentSessionRef;
  readonly transportId: string;
  readonly processId?: number;
}
/**
 * Reference to a specific turn within a session.
 */
export interface AgentTurnRef {
  readonly turnId: string;
  readonly sequenceNumber: number;
}

/**
 * Result of an agent turn.
 */
export interface AgentTurnResult {
  readonly terminal: boolean;
  readonly success: boolean;
  readonly stopReason?: "completed" | "interrupted" | "error" | "aborted";
  readonly errorMessage?: string;
  readonly messageCount: number;
  readonly outputText?: string;
}

/**
 * Status of an agent session.
 */
export interface AgentSessionStatus {
  readonly state: "idle" | "running" | "terminal" | "unknown";
  readonly lastTurnAt?: string;
  readonly messageCount: number;
}

// ============================================================================
// Execution Host References
// ============================================================================

/**
 * Serializable reference to an execution host (process/pane/terminal).
 */
export interface HostRef {
  readonly kind: string;
  readonly hostId: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Owner of a writer lease (controller or operator).
 */
export type WriterOwner = 
  | { type: "controller"; controllerId: string }
  | { type: "operator"; operatorId: string };

/**
 * Writer lease for single-writer guarantee.
 */
export interface WriterLease {
  readonly owner: WriterOwner;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly token: string;
  readonly hostId?: string;
  readonly generation?: number;
}

/**
 * Foreground capability levels.
 */
export type ForegroundCapability = "live" | "handoff" | "none";

/**
 * Request to foreground an execution.
 */
export interface ForegroundRequest {
  readonly operatorId: string;
  readonly capability: ForegroundCapability;
  readonly continuityNonce?: string;
}

/**
 * Result of foreground request.
 */
export interface ForegroundResult {
  readonly success: boolean;
  readonly capability: ForegroundCapability;
  readonly instructions?: string;
  readonly error?: string;
  readonly writerLease?: WriterLease;
}

/**
 * Status of an execution host.
 */
export interface HostStatus {
  readonly state: "running" | "stopped" | "unknown";
  readonly pid?: number;
  readonly startedAt?: string;
  readonly lastHeartbeatAt?: string;
}

// ============================================================================
// Approved Contract Packet
// ============================================================================

/**
 * Hashed input artifact reference.
 */
export interface HashedInputArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * Repository role in a task.
 */
export type RepositoryRole = "primary" | "target" | "reference";

/**
 * Repository contract for a task.
 */
export interface RepositoryContract {
  readonly role: RepositoryRole;
  readonly repoKey: string;
  readonly canonicalPath: string;
  readonly baseSha: string;
  readonly writableScope?: string[];
}

/**
 * Acceptance criterion for a task.
 */
export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly verificationCommand?: string;
  readonly expectedExitCode?: number;
}

/**
 * Task policy configuration.
 */
export interface TaskPolicy {
  readonly maxWallTimeHours: number;
  readonly maxImplementationRetries: number;
  readonly maxVerificationRetries?: number;
  readonly maxReviewRounds: number;
  readonly maxCandidateValidationRounds: number;
  readonly requireSecurityReview: boolean;
  readonly securityReviewTriggers: readonly string[];
  readonly securityReviewTriage?: "mandatory" | "advisory";
}

/**
 * Approved contract packet - immutable input to TCSF.
 */
export interface ApprovedContractPacket {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly title: string;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly artifacts: {
    readonly spec: HashedInputArtifact;
    readonly evidence?: HashedInputArtifact;
    readonly decisions?: HashedInputArtifact;
    readonly verification: HashedInputArtifact;
  };
  readonly repositories: RepositoryContract[];
  readonly acceptanceCriteria: AcceptanceCriterion[];
  readonly policy: TaskPolicy;
}

// ============================================================================
// Task State
// ============================================================================

/**
 * Task lifecycle phase.
 */
export type TaskPhase =
  | "approved"
  | "preparing"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "candidate_validating"
  | "waiting_for_decision"
  | "waiting_for_operator"
  | "ready_for_acceptance"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Task-level counters.
 */
export interface TaskCounters {
  readonly implementationAttempts: number;
  readonly reviewRounds: number;
  readonly candidateValidationRounds: number;
  readonly decisionRequests: number;
}

/**
 * Blocker information for a task.
 */
export interface TaskBlocker {
  readonly category: string;
  readonly message: string;
  readonly evidence?: string[];
  readonly since: string;
}

/**
 * TCSF Task entity.
 */
export interface TcsfTask {
  readonly id: string;
  readonly revision: number;
  readonly phase: TaskPhase;
  readonly contract: ApprovedContractPacket;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly counters: TaskCounters;
  readonly activeRunId?: string;
  readonly blocker?: TaskBlocker;
}

// ============================================================================
// Run State
// ============================================================================

/**
 * Run lifecycle status.
 */
export type RunStatus =
  | "created"
  | "running"
  | "paused"
  | "waiting"
  | "cancelling"
  | "terminal"
  | "failed"
  | "cancelled";

/**
 * Run stage in the SDLC workflow.
 */
export type RunStage =
  | "import_contract"
  | "validate"
  | "prepare_workspaces"
  | "implement"
  | "verify"
  | "review"
  | "candidate_validate"
  | "waiting_for_decision"
  | "waiting_for_operator"
  | "ready_for_acceptance"
  | "completed"
  | "failed";

/**
 * Run-level lease.
 */
export interface RunLease {
  readonly holderId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly token: string;
}

/**
 * Run-level counters.
 */
export interface RunCounters {
  readonly infrastructureRetries: number;
  readonly protocolRepairs: number;
  readonly verificationRepairs: number;
  readonly reviewRepairs: number;
  readonly candidateValidationRepairs: number;
}

/**
 * Run blocker information.
 */
export interface RunBlocker {
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly since: string;
}

/**
 * TCSF Run entity.
 */
export interface TcsfRun {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly status: RunStatus;
  readonly currentStage: RunStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lease?: RunLease;
  readonly counters: RunCounters;
  readonly activeExecutionId?: string;
  readonly blocker?: RunBlocker;
}

// ============================================================================
// Execution Record
// ============================================================================

/**
 * Execution role.
 */
export type ExecutionRole = "implementer" | "reviewer" | "candidate-validator";

/**
 * Execution status.
 */
export type ExecutionStatus =
  | "created"
  | "starting"
  | "running"
  | "idle"
  | "foregrounded"
  | "stopping"
  | "succeeded"
  | "failed"
  | "lost"
  | "cancelled";

/**
 * Serialized writer lease record.
 */
export interface WriterLeaseRecord {
  readonly owner: WriterOwner;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly token: string;
}

/**
 * Classified failure information.
 */
export interface ClassifiedFailure {
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly atTimestamp: string;
}

/**
 * Execution record for a run.
 */
export interface ExecutionRecord {
  readonly id: string;
  readonly runId: string;
  readonly role: ExecutionRole;
  readonly purpose: string;
  readonly status: ExecutionStatus;
  readonly agentRuntimeKind: string;
  readonly agentSession: AgentSessionRef;
  readonly executionHostKind: string;
  readonly host: HostRef;
  readonly foregroundCapability: ForegroundCapability;
  readonly writerLease?: WriterLeaseRecord;
  readonly workspaceRoots: string[];
  readonly readOnlyRoots: string[];
  readonly createdAt: string;
  readonly lastHeartbeatAt?: string;
  readonly lastTerminalTurnAt?: string;
  readonly activeTurnId?: string;
  readonly activeTurnLogicalId?: string;
  readonly activeTurnContentHash?: string;
  readonly activeTurnPrompt?: string;
  readonly finishedAt?: string;
  readonly failure?: ClassifiedFailure;
}

// ============================================================================
// Decision Request
// ============================================================================

/**
 * Critical decision category.
 */
export type CriticalDecisionCategory =
  | "behavior_change"
  | "api_contract"
  | "security"
  | "destructive_operation"
  | "scope_expansion"
  | "acceptance_criteria_change"
  | "architecture_violation"
  | "publication"
  | "unprovable_criterion"
  | "exhausted_repair";

/**
 * Decision option.
 */
export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly consequences: string;
}

/**
 * Artifact reference for decisions.
 */
export interface ArtifactRef {
  readonly taskId: string;
  readonly runId?: string;
  readonly relativePath: string;
  readonly sha256?: string;
}

/**
 * Decision request for human input.
 */
export interface DecisionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly category: CriticalDecisionCategory;
  readonly question: string;
  readonly evidence: ArtifactRef[];
  readonly options: DecisionOption[];
  readonly recommendation: string;
  readonly consequenceOfDelay: string;
  readonly requestedAt: string;
  readonly resumeStage: RunStage;
  readonly status: "open" | "resolved" | "superseded";
}

/**
 * Decision resolution.
 */
export interface DecisionResolution {
  readonly decisionId: string;
  readonly resolvedAt: string;
  readonly resolvedBy: string;
  readonly selectedOptionId: string;
  readonly rationale?: string;
}

// ============================================================================
// Events
// ============================================================================

/**
 * TCSF event types.
 */
export type TcsfEventType =
  | "task_created"
  | "task_phase_changed"
  | "run_created"
  | "run_stage_changed"
  | "run_status_changed"
  | "execution_created"
  | "execution_started"
  | "execution_turn_completed"
  | "execution_finished"
  | "verification_run"
  | "review_submitted"
  | "decision_requested"
  | "decision_resolved"
  | "blocker_raised"
  | "blocker_cleared"
  | "lease_acquired"
  | "lease_released"
  | "foreground_requested"
  | "foreground_returned"
  | "error";

/**
 * TCSF event base.
 */
export interface TcsfEventBase {
  readonly eventType: TcsfEventType;
  readonly taskId: string;
  readonly runId?: string;
  readonly executionId?: string;
  readonly timestamp: string;
  readonly sequence: number;
  readonly eventId?: string;
}

/**
 * Task phase changed event.
 */
export interface TaskPhaseChangedEvent extends TcsfEventBase {
  readonly eventType: "task_phase_changed";
  readonly fromPhase: TaskPhase;
  readonly toPhase: TaskPhase;
  readonly reason: string;
}

/**
 * Run stage changed event.
 */
export interface RunStageChangedEvent extends TcsfEventBase {
  readonly eventType: "run_stage_changed";
  readonly fromStage: RunStage;
  readonly toStage: RunStage;
  readonly reason: string;
}

/**
 * Execution finished event.
 */
export interface ExecutionFinishedEvent extends TcsfEventBase {
  readonly eventType: "execution_finished";
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly failure?: ClassifiedFailure;
}

/**
 * Decision requested event.
 */
export interface DecisionRequestedEvent extends TcsfEventBase {
  readonly eventType: "decision_requested";
  readonly decisionId: string;
  readonly category: CriticalDecisionCategory;
  readonly question: string;
}

/**
 * Union of all TCSF events.
 */
export type TcsfEvent = 
  | TcsfEventBase
  | TaskPhaseChangedEvent
  | RunStageChangedEvent
  | ExecutionFinishedEvent
  | DecisionRequestedEvent;

// ============================================================================
// Failure Classification
// ============================================================================

/**
 * Failure class for retry policy.
 */
export type FailureClass =
  | "infrastructure"
  | "protocol"
  | "semantic"
  | "verification"
  | "policy"
  | "workspace"
  | "candidate_validation"
  | "cancelled";

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  readonly infrastructureRetries: number;
  readonly protocolRepairs: number;
  readonly verificationRepairs: number;
  readonly reviewRepairs: number;
  readonly candidateValidationRepairs: number;
}

/**
 * Default retry policy.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  infrastructureRetries: 3,
  protocolRepairs: 1,
  verificationRepairs: 5,
  reviewRepairs: 3,
  candidateValidationRepairs: 2,
};
