import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunDriverHost, RunDriverRef, RunDriverStatus, StartRunDriverInput } from "../ports/run-driver-host.ts";

interface DriverManifest extends RunDriverRef { taskId: string; runId: string; startedAt: string; heartbeatAt: string; state?: "starting" | "running" | "stopped" | "failed"; exitedAt?: string; exitCode?: number; }
export class LocalRunDriverHost implements RunDriverHost {
  readonly kind = "local-run-driver";
  private readonly root: string;
  constructor(root: string, private readonly processPath = join(import.meta.dir, "..", "run-driver-process.ts"), private readonly leaseTtlMs = 30_000) { this.root = root; }
  async start(input: StartRunDriverInput): Promise<RunDriverRef> {
    const runRoot = join(this.root, "tasks", input.taskId, "runs", input.runId); const cwd = join(runRoot, "driver-cwd"); await mkdir(cwd, { recursive: true });
    const manifestPath = join(runRoot, "driver.json"); const claimPath = join(runRoot, "driver.claim");
    await this.acquireClaim(claimPath, manifestPath);
    const driverId = `${input.runId}-${Date.now().toString(36)}`; const startToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; const logPath = join(runRoot, "driver.log");
    const now = new Date().toISOString(); const claimed: DriverManifest = { kind: this.kind, driverId, pid: 0, startToken, logPath, cwd, taskId: input.taskId, runId: input.runId, startedAt: now, heartbeatAt: now, state: "starting" };
    await atomicJson(manifestPath, claimed);
    try {
      const log = Bun.file(logPath); const child = Bun.spawn([process.execPath, this.processPath, input.taskId, input.runId, input.tcsfHome, startToken, input.controllerId ?? `driver:${input.runId}`, input.leaseToken ?? ""], { cwd, detached: true, stdout: log, stderr: log, stdin: "ignore" }); child.unref();
      const running: DriverManifest = { ...claimed, pid: child.pid, state: "running", heartbeatAt: new Date().toISOString() }; await atomicJson(manifestPath, running); return running;
    } catch (error) { await rm(manifestPath, { force: true }); await rm(claimPath, { force: true }); throw error; }
  }
  async inspect(ref: RunDriverRef): Promise<RunDriverStatus> {
    if (!ref.pid) return { state: "unknown" }; try { process.kill(ref.pid, 0); return { state: "running", pid: ref.pid }; } catch { return { state: "stopped", pid: ref.pid }; }
  }
  async stop(ref: RunDriverRef, mode: "graceful" | "force"): Promise<void> { if (!ref.pid) return; const processes = await descendants(ref.pid); for (const pid of [ref.pid, ...processes].reverse()) { try { process.kill(pid, mode === "force" ? "SIGKILL" : "SIGTERM"); } catch {} } if (mode === "graceful") { for (let attempt = 0; attempt < 50 && await this.isAlive(ref.pid); attempt += 1) await new Promise(resolve => setTimeout(resolve, 100)); if (await this.isAlive(ref.pid)) { for (const pid of [ref.pid, ...await descendants(ref.pid)].reverse()) { try { process.kill(pid, "SIGKILL"); } catch {} } } } }
  async stopForRun(taskId: string, runId: string, mode: "graceful" | "force"): Promise<void> { const manifest = await readJson(join(this.root, "tasks", taskId, "runs", runId, "driver.json")); if (manifest) await this.stop(manifest, mode); }
  private async acquireClaim(claimPath: string, manifestPath: string): Promise<void> {
    try { await writeFile(claimPath, `${process.pid}\n`, { flag: "wx" }); return; } catch (error) {
      if (!isExists(error)) throw error;
      const current = await readJson(manifestPath); const alive = await this.isAlive(current?.pid); const stale = !current || !alive || Date.now() - new Date(current.heartbeatAt ?? 0).getTime() > this.leaseTtlMs;
      if (!stale) throw new Error(`driver already running for ${current?.runId ?? manifestPath}`);
      if (alive && current) {
        await this.stop(current, "force");
        for (let attempt = 0; attempt < 20 && await this.isAlive(current.pid); attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
        if (await this.isAlive(current.pid)) throw new Error(`stale driver ${current.pid} did not terminate safely`);
      }
      await rm(claimPath, { force: true }); await rm(manifestPath, { force: true });
      try { await writeFile(claimPath, `${process.pid}\n`, { flag: "wx" }); } catch { throw new Error("driver claim takeover raced with another owner"); }
    }
  }
  private async isAlive(pid: number | undefined): Promise<boolean> { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
}
async function readJson(path: string): Promise<DriverManifest | null> { try { return JSON.parse(await readFile(path, "utf8")) as DriverManifest; } catch { return null; } }
async function atomicJson(path: string, value: DriverManifest): Promise<void> { const temporary = `${path}.${process.pid}.${Date.now()}.tmp`; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, path); }
async function descendants(pid: number): Promise<number[]> { const child = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" }); const text = await new Response(child.stdout).text(); await child.exited; const direct = text.split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger); const nested = await Promise.all(direct.map(descendants)); return direct.concat(nested.flat()); }
function isExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST"); }
