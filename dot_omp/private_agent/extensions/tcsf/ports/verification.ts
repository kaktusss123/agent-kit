/**
 * VerificationRunner - Deterministic verification execution
 * 
 * Runs approved commands in the registered worktree, captures exit code and
 * bounded output, persists complete output to artifacts, and never lets an
 * LLM reinterpret a nonzero exit code as a pass.
 */

/** Input for running verification */
export interface VerificationRunInput {
  /** Task ID for artifact storage */
  readonly taskId: string;
  /** Working directory for command execution */
  readonly cwd: string;
  /** List of verification commands to run */
  readonly commands: VerificationCommand[];
  /** Maximum output lines to capture (stdout + stderr) */
  readonly outputLimit?: number;
  /** Timeout per command in seconds */
  readonly timeoutSeconds?: number;
  /** Artifact store path for output files */
  readonly artifactDir: string;
  /** Abort signal used by the stage ownership guard. */
  readonly signal?: AbortSignal;
}

/** A single verification command */
export interface VerificationCommand {
  /** Unique command ID */
  readonly id: string;
  /** Command name/description */
  readonly name: string;
  /** Command argv (preferred) or shell command */
  readonly argv?: string[];
  /** Shell command (if argv not provided) */
  readonly shell?: string;
  /** Shell to use for shell commands */
  readonly shellPath?: string;
  /** Environment variables */
  readonly env?: Record<string, string>;
  /** Expected exit code; defaults to zero */
  readonly expectedExitCode?: number;
  /** Whether to capture full output (default: true) */
  readonly captureOutput?: boolean;
  /** Whether failure is acceptable (default: false) */
  readonly optional?: boolean;

  readonly timeoutSeconds?: number;
}
/** Result of running verification */
export interface VerificationRunResult {
  /** Task ID */
  readonly taskId: string;
  /** Overall pass/fail status */
  readonly passed: boolean;
  /** Results for each command */
  readonly commandResults: CommandResult[];
  /** Timestamp when verification completed */
  readonly completedAt: string;
  /** Duration in milliseconds */
  readonly durationMs: number;
  /** Path to output artifacts directory */
  readonly artifactDir: string;
}

/** Result of a single command execution */
export interface CommandResult {
  /** Command ID */
  readonly commandId: string;
  /** Command name */
  readonly commandName: string;
  /** Exit code (null if not executed) */
  readonly exitCode: number | null;
  /** Whether command passed (exit code 0) */
  readonly passed: boolean;
  /** Whether command was optional */
  readonly optional: boolean;
  /** Bounded stdout */
  readonly stdout: string;
  /** Bounded stderr */
  readonly stderr: string;
  /** Path to full stdout artifact (if captured) */
  readonly stdoutArtifact?: string;
  /** Path to full stderr artifact (if captured) */
  readonly stderrArtifact?: string;
  /** Error message if command failed to execute */
  readonly error?: string;
  /** Duration in milliseconds */
  readonly durationMs: number;
  /** Whether all descendants were confirmed terminated after forced cleanup. */
  readonly cleanupSucceeded?: boolean;
  /** Whether the configured timeout timer fired. */
  readonly timedOut?: boolean;
  /** Failure metadata */
  readonly failureMetadata?: FailureMetadata;
}

/** Metadata about a failure */
export interface FailureMetadata {
  /** Failure type */
  readonly failureType: FailureType;
  /** Whether failure is retriable */
  readonly isRetriable: boolean;
  /** Suggested remediation */
  readonly remediation?: string;
  /** Additional context */
  readonly context?: Record<string, string>;
}

export type FailureType =
  | "nonzero_exit"
  | "timeout"
  | "spawn_failed"
  | "command_not_found"
  | "permission_denied"
  | "disk_full"
  | "interrupted"
  | "unknown";

/** Verification runner interface */
export interface VerificationRunner {
  /**
   * Run verification commands and capture results
   * 
   * @param input - Verification input
   * @returns Verification result with exit-code truth and failure metadata
   */
  run(input: VerificationRunInput): Promise<VerificationRunResult>;
}

/** Verification execution error */
export class VerificationExecutionError extends Error {
  constructor(
    message: string,
    public readonly commandId: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "VerificationExecutionError";
  }
}

/** Verification configuration error */
export class VerificationConfigError extends Error {
  constructor(
    message: string,
    public readonly reason: VerificationConfigReason
  ) {
    super(message);
    this.name = "VerificationConfigError";
  }
}

export type VerificationConfigReason =
  | "missing_command"
  | "invalid_argv"
  | "invalid_shell"
  | "invalid_cwd"
  | "output_limit_exceeded"
  | "timeout_invalid";
