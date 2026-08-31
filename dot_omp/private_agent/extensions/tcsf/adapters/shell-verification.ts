import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, VerificationCommand, VerificationRunInput, VerificationRunResult, VerificationRunner } from "../ports/verification.ts";

export interface ShellVerificationOptions { defaultTimeoutMs?: number; defaultOutputLimit?: number; terminationGraceMs?: number; }
function tail(value: string, limit: number): string { return value.length <= limit ? value : value.slice(-limit); }

export class ShellVerificationRunner implements VerificationRunner {
  constructor(private readonly options: ShellVerificationOptions = {}) {}
  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    const started = Date.now(); const commandResults: CommandResult[] = []; await mkdir(input.artifactDir, { recursive: true });
    for (const command of input.commands) commandResults.push(await this.runCommand(input, command));
    return { taskId: input.taskId, passed: commandResults.every(result => result.passed || result.optional), commandResults, completedAt: new Date().toISOString(), durationMs: Date.now() - started, artifactDir: input.artifactDir };
  }
  private async runCommand(input: VerificationRunInput, command: VerificationCommand): Promise<CommandResult> {
    const started = Date.now(); const timeoutMs = (command.timeoutSeconds ?? input.timeoutSeconds) !== undefined ? (command.timeoutSeconds ?? input.timeoutSeconds)! * 1000 : this.options.defaultTimeoutMs ?? 120_000; const outputLimit = input.outputLimit ?? this.options.defaultOutputLimit ?? 64 * 1024;
    const stdoutPath = join(input.artifactDir, `${command.id}.stdout.log`); const stderrPath = join(input.artifactDir, `${command.id}.stderr.log`);
    const executable = command.argv ?? [command.shellPath ?? "/bin/sh", "-c", command.shell ?? ""];
    let child: ReturnType<typeof Bun.spawn>; try { child = Bun.spawn(executable, { cwd: input.cwd, env: { ...process.env, ...command.env }, stdout: "pipe", stderr: "pipe", detached: true }); } catch (error) {
      return { commandId: command.id, commandName: command.name, exitCode: null, passed: false, optional: command.optional === true, stdout: "", stderr: "", durationMs: Date.now() - started, failureMetadata: { failureType: "spawn_failed", isRetriable: false, context: { error: String(error) } } };
    }
    let timedOut = false; let interrupted = false; let termination: Promise<boolean> | undefined;
    const terminate = (): Promise<boolean> => termination ?? (termination = (async () => { try { child.kill("SIGTERM"); } catch {} const tree = terminateProcessTree(child.pid, this.options.terminationGraceMs ?? 500); await tree; try { child.kill("SIGKILL"); } catch {} return tree; })());
    const timer = setTimeout(() => { timedOut = true; void terminate(); }, timeoutMs);
    const abort = () => { interrupted = true; void terminate(); };
    input.signal?.addEventListener("abort", abort, { once: true });
    const [stdout, stderr] = await Promise.all([capture(child.stdout as ReadableStream<Uint8Array> | null, stdoutPath, outputLimit, child.exited), capture(child.stderr as ReadableStream<Uint8Array> | null, stderrPath, outputLimit, child.exited)]);
    const exitCode = await Promise.race([child.exited, delay(1_000).then(() => null)]); clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    const cleanupSucceeded = termination ? await termination : await confirmedDead(child.pid);
    const expectedExitCode = command.expectedExitCode ?? 0; const passed = !timedOut && !interrupted && cleanupSucceeded && exitCode === expectedExitCode;
    const failureType = timedOut ? "timeout" : interrupted ? "interrupted" : exitCode === expectedExitCode ? undefined : "nonzero_exit";
    return { commandId: command.id, commandName: command.name, exitCode, passed, optional: command.optional === true, stdout: stdout.tail, stderr: stderr.tail, stdoutArtifact: stdoutPath, stderrArtifact: stderrPath, durationMs: Date.now() - started, cleanupSucceeded, timedOut, failureMetadata: failureType ? { failureType, isRetriable: timedOut || interrupted, context: { cleanupSucceeded: String(cleanupSucceeded) } } : undefined };
  }
}

async function capture(stream: ReadableStream<Uint8Array> | null, path: string, limit: number, exited: Promise<number>): Promise<{ tail: string }> {
  const file = await open(path, "w"); const reader = stream?.getReader(); const decoder = new TextDecoder(); let output = "";
  try { while (reader) { const next = await Promise.race([reader.read(), exited.then(() => ({ done: true as const, value: undefined })), delay(1_000).then(() => ({ done: true as const, value: undefined }))]); if (next.done) break; const chunk = decoder.decode(next.value, { stream: true }); await file.write(chunk); output = tail(output + chunk, limit); } output = tail(output + decoder.decode(), limit); } finally { reader?.releaseLock(); await file.close(); }
  return { tail: output };
}

async function terminateProcessTree(pid: number, graceMs: number): Promise<boolean> {
  try { process.kill(-pid, "SIGTERM"); } catch {}
  await new Promise(resolve => setTimeout(resolve, graceMs));
  try { process.kill(-pid, "SIGKILL"); } catch {}
  return true;
}
async function isAlive(pid: number): Promise<boolean> { try { process.kill(pid, 0); return true; } catch { return false; } }
async function confirmedDead(pid: number): Promise<boolean> { return !(await isAlive(pid)); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
