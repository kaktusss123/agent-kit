export interface FailpointContext {
  readonly taskId: string;
  readonly runId: string;
}

export interface FailpointPort {
  pause(name: "after_verification_before_stage_update", context: FailpointContext): Promise<void>;
}
