import type { ArtifactRef, TcsfEvent, TcsfRun, TcsfTask } from "../core/types.ts";
export interface CreateStoredTaskInput { task: TcsfTask; }
export interface StoredTaskRef { taskId: string; root: string; revision: number; }
export interface ArtifactStore {
  createTask(input: CreateStoredTaskInput): Promise<StoredTaskRef>;
  loadTask(taskId: string): Promise<TcsfTask>;
  saveTask(task: TcsfTask, expectedRevision: number): Promise<TcsfTask>;
  loadRun(taskId: string, runId: string): Promise<TcsfRun>;
  saveRun(run: TcsfRun, expectedRevision: number | null): Promise<TcsfRun>;
  appendEvent(taskId: string, event: TcsfEvent): Promise<void>;
  writeArtifact(taskId: string, relativePath: string, data: Uint8Array): Promise<ArtifactRef>;
  readArtifact(ref: ArtifactRef): Promise<Uint8Array>;
  claimArtifact?(taskId: string, relativePath: string, data: Uint8Array): Promise<ArtifactRef>;
}
