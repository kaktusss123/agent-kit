import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultFactory } from "../../runner.ts";

const acceptanceRoot = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
const scenarioRoot = join(acceptanceRoot, "recovery", "e2e-01", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(scenarioRoot, { recursive: true }); await writeFile(join(scenarioRoot, "runner-source.ts"), await Bun.file(import.meta.path).text());
const eventsPath = join(scenarioRoot, "stage-events.jsonl"); const events: Array<Record<string, unknown>> = [];
async function trace(stage: string, operation: string, detail: Record<string, unknown> = {}): Promise<void> { const event = { at: new Date().toISOString(), stage, operation, ...detail }; events.push(event); await writeFile(eventsPath, events.map(item => JSON.stringify(item)).join("\n") + "\n"); }
async function git(cwd: string, args: string[]): Promise<string> { const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const stdout = await new Response(child.stdout).text(); const stderr = await new Response(child.stderr).text(); const exitCode = await child.exited; if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`); return stdout.trim(); }
async function bounded<T>(label: string, operation: Promise<T>, timeoutMs = 10_000): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
async function jsonFile(path: string): Promise<Record<string, unknown> | null> { try { const parsed: unknown = JSON.parse(await readFile(path, "utf8")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
async function gitState(cwd: string): Promise<Record<string, unknown>> { return { head: await git(cwd, ["rev-parse", "HEAD"]), status: await git(cwd, ["status", "--short"]), diffStat: await git(cwd, ["diff", "--stat"]) }; }
const repo = join(scenarioRoot, "fixture-repo"); const tcsfHome = join(scenarioRoot, "tcsf-home");
await mkdir(repo, { recursive: true }); await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.email", "tcsf@example.invalid"]); await git(repo, ["config", "user.name", "TCSF Recovery"]); await writeFile(join(repo, "README.md"), "fixture\n"); await git(repo, ["add", "README.md"]); await git(repo, ["commit", "-m", "fixture"]); const baseSha = await git(repo, ["rev-parse", "HEAD"]); const gitBefore = await gitState(repo);
const packet = { schemaVersion: 1 as const, taskId: "recovery-e2e-01", title: "Create the TCSF E2E marker file", approvalId: "recovery-approval", approvedAt: new Date().toISOString(), artifacts: { spec: { path: "spec.md", sha256: "a", size: 1 }, verification: { path: "verify.md", sha256: "b", size: 1 } }, repositories: [{ repoKey: "primary", canonicalPath: repo, baseSha, role: "primary" as const, writableScope: ["tcsf-e2e.txt"] }], acceptanceCriteria: [{ id: "marker", description: "Create tcsf-e2e.txt containing exactly TCSF_E2E_OK", verificationCommand: 'test "$(cat tcsf-e2e.txt)" = TCSF_E2E_OK' }], policy: { maxWallTimeHours: 1, maxImplementationRetries: 1, maxReviewRounds: 1, maxCandidateValidationRounds: 1, requireSecurityReview: false, securityReviewTriggers: [] } };
await writeFile(join(scenarioRoot, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`); await trace("setup", "fixture-created", { repo, tcsfHome, baseSha });
const factory = createDefaultFactory(tcsfHome, message => { void trace("driver", "notification", { message }); }); let driverPid: number | undefined; let runId: string | undefined; let terminal = false; let failure: string | undefined;
try {
  await trace("import", "begin"); await bounded("importApprovedContract", factory.importApprovedContract(packet)); await trace("import", "complete");
  await writeFile(join(scenarioRoot, "manifest-before.json"), `${JSON.stringify(await factory.getStatus(packet.taskId), null, 2)}\n`);
  await trace("start", "begin"); const started = await bounded("startRun", factory.startRun(packet.taskId)); runId = started.run.id; driverPid = started.driver.pid; await trace("start", "complete", { runId, driver: started.driver });
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    const status = await bounded("getStatus", factory.getStatus(packet.taskId), 5_000); const run = status.run; const driver = runId ? await jsonFile(join(tcsfHome, "tasks", packet.taskId, "runs", runId, "driver.json")) : null; await trace("poll", "status", { attempt, taskPhase: status.task.phase, runStage: run?.currentStage, runStatus: run?.status, driver });
    if (status.task.phase === "ready_for_acceptance" || status.task.phase === "failed" || status.task.phase === "cancelled") { terminal = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  await trace("result", "complete", { terminal });
} catch (error) { failure = String(error); await trace("result", "error", { error: failure, runId }); } finally {
  const runRoot = runId ? join(tcsfHome, "tasks", packet.taskId, "runs", runId) : undefined; const driver = runRoot ? await jsonFile(join(runRoot, "driver.json")) : null;
  const aliveBeforeCleanup = driverPid ? await isAlive(driverPid) : false;
  if (runRoot) {
    await writeFile(join(scenarioRoot, "manifest-after.json"), `${JSON.stringify(await factory.getStatus(packet.taskId), null, 2)}\n`);
    await writeFile(join(scenarioRoot, "session-refs.json"), `${JSON.stringify({ execution: await jsonFile(join(runRoot, "executions", `${runId}-implementer.json`)), reviewerAttempts: await jsonFile(join(tcsfHome, "sessions", "review-attempts", `${runId.replace(/[^A-Za-z0-9_.-]/gu, "_")}.json`)) }, null, 2)}\n`);
    await writeFile(join(scenarioRoot, "event-excerpts.json"), `${JSON.stringify({ taskEvents: await readFile(join(tcsfHome, "tasks", packet.taskId, "events.jsonl"), "utf8"), driverEvents: await readFile(join(runRoot, "driver-events.jsonl"), "utf8") }, null, 2)}\n`);
    await writeFile(join(scenarioRoot, "stdout.txt"), await readFile(join(runRoot, "driver.log"), "utf8").catch(() => "")); await writeFile(join(scenarioRoot, "stderr.txt"), "");
  }
  const gitAfter = await gitState(repo); await writeFile(join(scenarioRoot, "git-before.json"), `${JSON.stringify(gitBefore, null, 2)}\n`); await writeFile(join(scenarioRoot, "git-after.json"), `${JSON.stringify(gitAfter, null, 2)}\n`);
  await writeFile(join(scenarioRoot, "commands.jsonl"), `${JSON.stringify({ command: "bun run tests/recovery/e2e-01.ts", capturedAt: new Date().toISOString() })}\n`); await writeFile(join(scenarioRoot, "code-revision.json"), `${JSON.stringify({ repoHead: await git(repo, ["rev-parse", "HEAD"]), harness: "tests/recovery/e2e-01.ts", tcsfSource: "dot_omp/private_agent/extensions/tcsf", ompVersion: "omp/18.0.11", bunVersion: "1.4.0" }, null, 2)}\n`);
  let cleanup = "not-needed"; if (driverPid) { try { process.kill(driverPid, "SIGTERM"); cleanup = "signal-sent"; await trace("cleanup", "driver-signaled", { driverPid }); } catch (error) { cleanup = `signal-failed:${String(error)}`; await trace("cleanup", "driver-signal-failed", { driverPid, error: String(error) }); } }
  for (let attempt = 0; attempt < 100 && driverPid && await isAlive(driverPid); attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
  const aliveAfterCleanup = driverPid ? await isAlive(driverPid) : false; await writeFile(join(scenarioRoot, "process-identities.json"), `${JSON.stringify({ driverPid, driver, aliveBeforeCleanup, aliveAfterCleanup, cleanupObservedAt: new Date().toISOString() }, null, 2)}\n`);
  await trace("cleanup", "complete", { scenarioRoot, aliveBeforeCleanup, aliveAfterCleanup });
  await writeFile(join(scenarioRoot, "verdict.json"), `${JSON.stringify({ id: "E2E-01", verdict: !failure && terminal && !aliveAfterCleanup ? "PASS" : "FAIL", failure: failure ?? null, cleanup, scenarioRoot }, null, 2)}\n`);
}
async function isAlive(pid: number): Promise<boolean> { const child = Bun.spawn(["ps", "-p", String(pid), "-o", "pid="], { stdout: "pipe", stderr: "ignore" }); const output = await new Response(child.stdout).text(); await child.exited; return output.trim() !== ""; }
console.log(JSON.stringify({ scenarioRoot, runId, terminal, failure, stages: events.map(event => `${String(event.stage)}:${String(event.operation)}`) }, null, 2));
