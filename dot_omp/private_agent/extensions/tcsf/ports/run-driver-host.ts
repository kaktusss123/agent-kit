export interface StartRunDriverInput { taskId: string; runId: string; tcsfHome: string; controllerId?: string; leaseToken?: string; }
export interface RunDriverRef { kind: string; driverId: string; startToken: string; logPath: string; cwd?: string; pid?: number; }
export interface RunDriverStatus { state: "running" | "stopped" | "lost" | "unknown"; pid?: number; heartbeatAt?: string; owner?: string; }
export interface RunDriverHost {
  start(input: StartRunDriverInput): Promise<RunDriverRef>;
  inspect(ref: RunDriverRef): Promise<RunDriverStatus>;
  stop(ref: RunDriverRef, mode: "graceful" | "force"): Promise<void>;
  stopForRun?(taskId: string, runId: string, mode: "graceful" | "force"): Promise<void>;
}
