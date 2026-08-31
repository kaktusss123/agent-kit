import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ArtifactRef, TcsfEvent, TcsfTask } from "../core/types.ts";
import type { ArtifactStore, CreateStoredTaskInput, StoredTaskRef } from "../ports/artifact-store.ts";


export function defaultTcsfRoot(env: Record<string, string | undefined> = process.env): string {
  return env.TCSF_HOME || join(env.HOME || process.env.HOME || ".", ".omp", "tcsf");
}
function safePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.split(/[\\/]/u).includes("..")) throw new Error("artifact path escapes task root");
  const result = resolve(root, relativePath);
  if (result !== resolve(root) && !result.startsWith(resolve(root) + sep)) throw new Error("artifact path escapes task root");
  return result;
}
async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}
async function assertNoSymlink(root: string, relativePath: string): Promise<void> {
  let current = resolve(root); for (const segment of relativePath.split(/[\\/]/u)) { if (!segment) continue; current = join(current, segment); try { const metadata = await lstat(current); if (metadata.isSymbolicLink()) throw new Error(`artifact path contains symlink: ${relativePath}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; } }
}
const LOCK_STALE_MS = 30_000; const LOCK_WAIT_ATTEMPTS = 20; const LOCK_WAIT_MS = 5;
interface LockMetadata { pid: number; processStartToken: string; hostIdentity: string; acquiredAt: string; target: string; expectedRevision: number | null; }
const hostIdentity = hostname();
const processStartToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;
function lockMetadata(target: string, expectedRevision: number | null): LockMetadata { return { pid: process.pid, processStartToken, hostIdentity, acquiredAt: new Date().toISOString(), target, expectedRevision }; }
async function withStructuredLock<T>(lockPath: string, metadata: LockMetadata, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  let attempts = 0; let acquired = false;
  while (attempts < LOCK_WAIT_ATTEMPTS) {
    attempts += 1;
    try { await writeFile(lockPath, `${JSON.stringify(metadata)}\n`, { flag: "wx" }); acquired = true; break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: LockMetadata;
      try { current = JSON.parse(await readFile(lockPath, "utf8")) as LockMetadata; } catch { throw new Error(`corrupt lock requires reconciliation: ${lockPath}`); }
      if (!Number.isInteger(current.pid) || !current.processStartToken || !current.hostIdentity || !current.acquiredAt || !current.target || !Object.hasOwn(current, "expectedRevision")) throw new Error(`corrupt lock requires reconciliation: ${lockPath}`);
      let alive = false; try { process.kill(current.pid, 0); alive = true; } catch {}
      if (alive && current.processStartToken === processStartToken) { await new Promise(resolve => setTimeout(resolve, LOCK_WAIT_MS)); continue; }
      const expired = Date.now() - new Date(current.acquiredAt).getTime() > LOCK_STALE_MS;
      if (alive || !expired) throw new Error(`structured lock is held for ${current.target}`);
      await rm(lockPath);
    }
  }
  if (!acquired) throw new Error(`structured lock wait expired for ${metadata.target}`);
  try { return await action(); } finally { await rm(lockPath, { force: true }); }
}

export class FsArtifactStore implements ArtifactStore {
  readonly root: string;
  constructor(root = defaultTcsfRoot()) { this.root = resolve(root); }
  taskRoot(taskId: string): string { return safePath(join(this.root, "tasks"), taskId); }
  private taskPath(taskId: string): string { return join(this.taskRoot(taskId), "task.json"); }
  async createTask(input: CreateStoredTaskInput): Promise<StoredTaskRef> {
    await assertNoSymlink(this.root, join("tasks", input.task.id));
    const path = this.taskPath(input.task.id);
    try { await stat(path); throw new Error(`task already exists: ${input.task.id}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(join(this.taskRoot(input.task.id), "contract"), { recursive: true });
    await mkdir(join(this.taskRoot(input.task.id), "runs"), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(input.task, null, 2)}\n`);
    return { taskId: input.task.id, root: this.taskRoot(input.task.id), revision: input.task.revision };
  }
  async loadTask(taskId: string): Promise<TcsfTask> { return JSON.parse(await readFile(this.taskPath(taskId), "utf8")) as TcsfTask; }
  async loadRun(taskId: string, runId: string): Promise<import("../core/types.ts").TcsfRun> { return JSON.parse(await readFile(safePath(this.taskRoot(taskId), `runs/${runId}/run.json`), "utf8")) as import("../core/types.ts").TcsfRun; }
  async saveRun(run: import("../core/types.ts").TcsfRun, expectedRevision: number | null): Promise<import("../core/types.ts").TcsfRun> {
    await assertNoSymlink(this.root, join("tasks", run.taskId, "runs", run.id)); const currentPath = safePath(this.taskRoot(run.taskId), `runs/${run.id}/run.json`);
    return withStructuredLock(`${currentPath}.lock`, lockMetadata(`${run.taskId}/${run.id}`, expectedRevision), async () => {
      let current: import("../core/types.ts").TcsfRun | undefined;
      try { current = JSON.parse(await readFile(currentPath, "utf8")) as import("../core/types.ts").TcsfRun; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) throw new Error(`run revision conflict: expected ${expectedRevision ?? "absent"}, got ${current?.revision ?? "absent"}`);
      if (expectedRevision !== null && run.revision <= expectedRevision) throw new Error("saved run revision must advance");
      await atomicWrite(currentPath, `${JSON.stringify(run, null, 2)}\n`); return run;
    });
  }
  async saveTask(task: TcsfTask, expectedRevision: number): Promise<TcsfTask> {
    await assertNoSymlink(this.root, join("tasks", task.id)); const currentPath = this.taskPath(task.id);
    return withStructuredLock(`${currentPath}.lock`, lockMetadata(task.id, expectedRevision), async () => {
      const current = await this.loadTask(task.id);
      if (current.revision !== expectedRevision) throw new Error(`revision conflict: expected ${expectedRevision}, got ${current.revision}`);
      if (task.revision <= expectedRevision) throw new Error("saved revision must advance");
      await atomicWrite(currentPath, `${JSON.stringify(task, null, 2)}\n`); return task;
    });
  }
  async appendEvent(taskId: string, event: TcsfEvent): Promise<void> {
    await assertNoSymlink(this.root, join("tasks", taskId));
    const path = join(this.taskRoot(taskId), "events.jsonl");
    await withStructuredLock(`${path}.lock`, lockMetadata(taskId, event.sequence), async () => {
      let raw = ""; try { raw = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parts = raw.split("\n"); if (parts.at(-1) === "") parts.pop();
      const events: TcsfEvent[] = []; const serialized: string[] = [];
      for (let index = 0; index < parts.length; index += 1) {
        if (!parts[index]) continue;
        try { const parsed = JSON.parse(parts[index]) as TcsfEvent; events.push(parsed); serialized.push(JSON.stringify(parsed)); }
        catch { if (index !== parts.length - 1) throw new Error(`corrupt event record at sequence ${index + 1}`); await atomicWrite(path, serialized.length ? `${serialized.join("\n")}\n` : ""); }
      }
      const priorIds = new Set(events.map(item => (item as TcsfEvent & { eventId?: string }).eventId).filter((id): id is string => Boolean(id)));
      const suppliedId = (event as TcsfEvent & { eventId?: string }).eventId; if (suppliedId && priorIds.has(suppliedId)) throw new Error(`duplicate event id: ${suppliedId}`);
      const lastSequence = events.reduce((max, item) => Math.max(max, item.sequence), 0); const eventId = suppliedId ?? `${taskId}:${lastSequence + 1}:${event.eventType}`;
      const persisted = { ...event, sequence: Math.max(lastSequence + 1, event.sequence), eventId };
      await appendFile(path, `${JSON.stringify(persisted)}\n`, "utf8");
    });
  }
  async writeArtifact(taskId: string, relativePath: string, data: Uint8Array): Promise<ArtifactRef> {
    await assertNoSymlink(this.root, join("tasks", taskId, relativePath));
    const path = safePath(this.taskRoot(taskId), relativePath);
    if (relativePath === "contract/packet.json" || relativePath.startsWith("contract/")) {
      try { await stat(path); throw new Error(`frozen contract artifact already exists: ${relativePath}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await atomicWrite(path, data);
    const hash = createHash("sha256").update(data).digest("hex");
    return { taskId, relativePath, sha256: hash };
  }
  async claimArtifact(taskId: string, relativePath: string, data: Uint8Array): Promise<ArtifactRef> {
    await assertNoSymlink(this.root, join("tasks", taskId, relativePath)); const path = safePath(this.taskRoot(taskId), relativePath); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: "wx" }); return { taskId, relativePath, sha256: createHash("sha256").update(data).digest("hex") };
  }
  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    await assertNoSymlink(this.root, join("tasks", ref.taskId, ref.relativePath));
    const data = await readFile(safePath(this.taskRoot(ref.taskId), ref.relativePath));
    if (ref.sha256 && createHash("sha256").update(data).digest("hex") !== ref.sha256) throw new Error("artifact hash mismatch");
    return data;
  }
}
