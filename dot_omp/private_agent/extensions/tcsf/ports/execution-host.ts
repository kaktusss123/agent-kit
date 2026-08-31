import type { ForegroundRequest, ForegroundResult, HostRef, HostStatus, WriterLease, WriterOwner } from "../core/types.ts";
export interface StartHostInput { executionId: string; cwd: string; session: string; processId?: number; command?: string[]; environment?: Record<string, string>; }
export interface ExecutionHost {
  readonly kind: string;
  start(input: StartHostInput): Promise<HostRef>;
  inspect(ref: HostRef): Promise<HostStatus>;
  stop(ref: HostRef, mode: "graceful" | "force"): Promise<void>;
  acquireWriter(ref: HostRef, owner: WriterOwner): Promise<WriterLease>;
  releaseWriter(lease: WriterLease): Promise<void>;
  renewWriter?(lease: WriterLease): Promise<WriterLease>;
  foreground(ref: HostRef, input: ForegroundRequest): Promise<ForegroundResult>;
}
