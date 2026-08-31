import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ForegroundRequest, ForegroundResult, HostRef, HostStatus, WriterLease, WriterOwner } from "../core/types.ts";
import type { ExecutionHost, StartHostInput } from "../ports/execution-host.ts";

interface LocalHostMetadata { [key: string]: unknown; pid: number; startedAt: string; cwd: string; session: string; }
export class LocalProcessHost implements ExecutionHost {
  readonly kind = "local-process";
  private readonly hosts = new Map<string, ReturnType<typeof Bun.spawn>>();
  private readonly leases = new Map<string, WriterLease>();
  constructor(private readonly stateRoot: string) {}
  async start(input: StartHostInput): Promise<HostRef> {
    const hostId = `${input.executionId}-${Date.now().toString(36)}`; const child = input.processId ? undefined : Bun.spawn(input.command ?? ["sleep", "2147483647"], { cwd: input.cwd, env: { ...process.env, ...input.environment }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    if (child) this.hosts.set(hostId, child);
    const metadata: LocalHostMetadata = { pid: input.processId ?? child!.pid, startedAt: new Date().toISOString(), cwd: input.cwd, session: input.session, managedExternally: Boolean(input.processId) };
    await mkdir(this.stateRoot, { recursive: true }); await writeFile(join(this.stateRoot, `${hostId}.json`), `${JSON.stringify(metadata)}\n`);
    return { kind: this.kind, hostId, metadata };
  }
  async inspect(ref: HostRef): Promise<HostStatus> {
    const local = this.hosts.get(ref.hostId); const metadata = ref.metadata as LocalHostMetadata | undefined; const pid = metadata?.pid;
    if (local) return { state: "running", pid, startedAt: metadata?.startedAt };
    if (!pid) return { state: "unknown" };
    try { process.kill(pid, 0); return { state: "running", pid, startedAt: metadata?.startedAt }; } catch { return { state: "stopped", pid, startedAt: metadata?.startedAt }; }
  }
  async stop(ref: HostRef, mode: "graceful" | "force"): Promise<void> {
    const local = this.hosts.get(ref.hostId); const metadata = ref.metadata as LocalHostMetadata | undefined; const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
    if (local) { await killProcessTree(local.pid, signal); await local.exited; this.hosts.delete(ref.hostId); } else if (metadata?.pid) await killProcessTree(metadata.pid, signal);
    await rm(join(this.stateRoot, `${ref.hostId}.json`), { force: true });
  }
  async acquireWriter(ref: HostRef, owner: WriterOwner): Promise<WriterLease> {
    return this.withTransitionLock(ref, () => this.acquireWriterUnlocked(ref, owner));
  }
  private async acquireWriterUnlocked(ref: HostRef, owner: WriterOwner): Promise<WriterLease> {
    await mkdir(this.stateRoot, { recursive: true }); const path = join(this.stateRoot, `${ref.hostId}.lease.json`); let current: WriterLease | undefined;
    if (existsSync(path)) { try { current = JSON.parse(await readFile(path, "utf8")) as WriterLease; } catch { throw new Error(`corrupt writer lease requires reconciliation: ${path}`); } }
    if (current && new Date(current.expiresAt ?? 0).getTime() > Date.now()) throw new Error(`writer lease held by ${JSON.stringify(current.owner)}`);
    const generation = (current?.generation ?? 0) + 1; const lease: WriterLease = { owner, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), token: `${ref.hostId}-${Math.random().toString(36).slice(2)}`, hostId: ref.hostId, generation };
    try { await writeFile(path, `${JSON.stringify(lease)}\n`, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST" && current && new Date(current.expiresAt ?? 0).getTime() <= Date.now()) { await rm(path); await writeFile(path, `${JSON.stringify(lease)}\n`, { flag: "wx" }); } else throw new Error("writer lease acquisition raced with another owner"); }
    this.leases.set(ref.hostId, lease); return lease;
  }
  private async withTransitionLock<T>(ref: HostRef, action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.stateRoot, `${ref.hostId}.lease.json.handoff.lock`); await mkdir(this.stateRoot, { recursive: true }); let locked = false;
    for (let attempt = 0; attempt < 20 && !locked; attempt += 1) { try { await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" }); locked = true; } catch { const holder = Number((await readFile(lockPath, "utf8").catch(() => "0")).trim()); let alive = false; if (Number.isInteger(holder) && holder > 0) { try { process.kill(holder, 0); alive = true; } catch {} } if (!alive) await rm(lockPath, { force: true }); else await new Promise(resolve => setTimeout(resolve, 5)); } }
    if (!locked) throw new Error("writer lease transition raced with another owner");
    try { return await action(); } finally { await rm(lockPath, { force: true }); }
  }
  async releaseWriter(lease: WriterLease): Promise<void> {
    const hostId = lease.hostId ?? [...this.leases.entries()].find(([, current]) => current.token === lease.token)?.[0]; if (!hostId) throw new Error("writer lease has no host identity");
    await this.withTransitionLock({ kind: this.kind, hostId }, async () => {
      const path = join(this.stateRoot, `${hostId}.lease.json`); let current: WriterLease;
      try { current = JSON.parse(await readFile(path, "utf8")) as WriterLease; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.leases.delete(hostId); return; } throw new Error(`corrupt or missing writer lease requires reconciliation: ${path}`); }
      if (current.hostId !== hostId || current.token !== lease.token || current.generation !== lease.generation || !sameWriterOwner(current.owner, lease.owner)) throw new Error("writer lease release rejected: lease is not current");
      await rm(path); this.leases.delete(hostId);
    });
  }
  async renewWriter(lease: WriterLease): Promise<WriterLease> {
    const hostId = lease.hostId; if (!hostId) throw new Error("writer lease has no host identity");
    return this.withTransitionLock({ kind: this.kind, hostId }, async () => {
      const path = join(this.stateRoot, `${hostId}.lease.json`); let current: WriterLease;
      try { current = JSON.parse(await readFile(path, "utf8")) as WriterLease; } catch { throw new Error(`corrupt or missing writer lease requires reconciliation: ${path}`); }
      if (current.hostId !== hostId || current.token !== lease.token || current.generation !== lease.generation || !sameWriterOwner(current.owner, lease.owner)) throw new Error("writer lease renewal rejected: lease is not current");
      const renewed = { ...current, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }; const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(renewed)}\n`); await rename(temporary, path); this.leases.set(hostId, renewed); return renewed;
    });
  }
  async foreground(ref: HostRef, input: ForegroundRequest): Promise<ForegroundResult> {
    const metadata = ref.metadata as LocalHostMetadata | undefined; const path = join(this.stateRoot, `${ref.hostId}.lease.json`); const lockPath = `${path}.handoff.lock`; let lease: WriterLease;
    let locked = false; for (let attempt = 0; attempt < 20 && !locked; attempt += 1) { try { await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" }); locked = true; } catch { const holder = Number((await readFile(lockPath, "utf8").catch(() => "0")).trim()); let alive = false; if (Number.isInteger(holder) && holder > 0) { try { process.kill(holder, 0); alive = true; } catch {} } if (!alive) await rm(lockPath, { force: true }); else await new Promise(resolve => setTimeout(resolve, 5)); } } if (!locked) throw new Error("foreground handoff raced with another writer transition");
    try {
      let current: WriterLease | undefined;
      try { current = JSON.parse(await readFile(path, "utf8")) as WriterLease; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`corrupt writer lease requires reconciliation: ${path}`); }
      if (current && new Date(current.expiresAt ?? 0).getTime() > Date.now() && current.owner.type === "controller") { lease = { ...current, owner: { type: "operator", operatorId: input.operatorId }, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), token: `${ref.hostId}-${Math.random().toString(36).slice(2)}`, generation: (current.generation ?? 0) + 1 }; const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temporary, `${JSON.stringify(lease)}\n`); await rename(temporary, path); this.leases.set(ref.hostId, lease); } else lease = await this.acquireWriterUnlocked(ref, { type: "operator", operatorId: input.operatorId });
    } finally { await rm(lockPath, { force: true }); }
    return { success: true, capability: "handoff", writerLease: lease, instructions: `Resume the same OMP session with: omp --cwd ${metadata?.cwd ?? process.cwd()} --resume ${metadata?.session ?? ref.hostId}. Continuity nonce: ${input.continuityNonce ?? "not-issued"}. Lease token: ${lease.token}` };
  }
}
async function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  const probe = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" }); const output = await new Response(probe.stdout).text(); await probe.exited;
  for (const child of output.split(/\s+/u).filter(Boolean)) { const childPid = Number(child); if (Number.isInteger(childPid) && childPid > 0) await killProcessTree(childPid, signal); }
  try { process.kill(pid, signal); } catch {}
}
function sameWriterOwner(left: WriterOwner, right: WriterOwner): boolean {
  return left.type === right.type && (left.type === "controller" ? left.controllerId === (right as { type: "controller"; controllerId: string }).controllerId : left.operatorId === (right as { type: "operator"; operatorId: string }).operatorId);
}
