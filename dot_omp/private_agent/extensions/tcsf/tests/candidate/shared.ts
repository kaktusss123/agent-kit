import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OmpCandidateRuntime } from "../../adapters/omp/candidate-runtime.ts";

const tcsfRoot = join(import.meta.dir, "..", "..");
const sourceRoot = join(tcsfRoot, "..", "..", "..", "..");
const sourceIndex = join(tcsfRoot, "index.ts");
const candidateHost = join(tcsfRoot, "candidate-host.ts");
const activeIndex = join(process.env.HOME ?? ".", ".omp", "agent", "extensions", "tcsf", "index.ts");

export async function runCandidate(id: string): Promise<void> {
  const root = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
  const scenario = process.env.TCSF_CANDIDATE_SCENARIO_ROOT ?? join(root, "candidate", id, new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(scenario, { recursive: true });
  const parent = { sourceIndex: await fileHash(sourceIndex), activeIndex: await fileHash(activeIndex), candidateHost: await fileHash(candidateHost), capturedAt: new Date().toISOString() };
  await writeFile(join(scenario, "immutable-parent.json"), `${JSON.stringify(parent, null, 2)}\n`);
  let result: unknown;
  let registryCheck: unknown;
  let scenarioResult: Awaited<ReturnType<OmpCandidateRuntime["executeScenario"]>> | undefined;
  if (id === "C-01" || id === "C-02") {
    const inspection = await new OmpCandidateRuntime().inspectCandidate({ extensionPath: sourceIndex, cwd: sourceRoot, sessionDirectory: join(scenario, "candidate-runtime") });
    result = inspection;
    if (id === "C-01") registryCheck = { loadedExactlyOnce: inspection.passed && inspection.candidatePid !== undefined, candidatePid: inspection.candidatePid, duplicateCommands: inspection.duplicateCommands, duplicateTools: inspection.duplicateTools };
    else {
      const expectedCommands = ["tcsf_run", "tcsf_status", "tcsf_resume", "tcsf_attach", "tcsf_return", "tcsf_decide", "tcsf_cancel", "tcsf_accept"];
      const expectedTools = ["tcsf_status", "tcsf_request_decision", "tcsf_review_result", "tcsf_checkpoint"];
      const observedCommands = inspection.commandNames.filter(name => name.startsWith("tcsf_"));
      const observedTools = inspection.toolNames.filter(name => name.startsWith("tcsf_"));
      const commandCounts = counts(observedCommands);
      const toolCounts = counts(observedTools);
      const legacyLifecycle = inspection.commandNames.filter(name => ["task_handoff", "task_status", "task_submit", "task_accept"].includes(name));
      registryCheck = { commandNames: inspection.commandNames, toolNames: inspection.toolNames, observedCommands, observedTools, expectedCommands, expectedTools, commandCounts, toolCounts, duplicateCommands: inspection.duplicateCommands, duplicateTools: inspection.duplicateTools, legacyLifecycle, unexpectedCommands: observedCommands.filter(name => !expectedCommands.includes(name)), unexpectedTools: observedTools.filter(name => !expectedTools.includes(name)), exact: expectedCommands.every(name => commandCounts[name] === 1) && expectedTools.every(name => toolCounts[name] === 1) && observedCommands.length === expectedCommands.length && observedTools.length === expectedTools.length && legacyLifecycle.length === 0 && inspection.duplicateCommands.length === 0 && inspection.duplicateTools.length === 0 };
      await writeFile(join(scenario, "registry-check.json"), `${JSON.stringify(registryCheck, null, 2)}\n`);
    }
  } else {
    const fixture = await createFixture(id, scenario);
    const manifestPath = join(scenario, "scenario-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({ id, operation: `candidate-${id.toLowerCase()}-workflow`, scenarioRoot: scenario, taskId: fixture.taskId, packetPath: fixture.packetPath, tcsfHome: join(scenario, "candidate-runtime", "tcsf-home") }, null, 2)}\n`);
    scenarioResult = await new OmpCandidateRuntime().executeScenario({ extensionPath: sourceIndex, cwd: sourceRoot, sessionDirectory: join(scenario, "candidate-runtime"), scenarioId: id, scenarioManifestPath: manifestPath, timeoutMs: 300_000 });
    result = { transport: scenarioResult, candidateExecution: await json(join(scenario, "candidate-execution.json")), hostEvents: await text(join(scenario, "candidate-host-events.jsonl")), taskArtifacts: await collectArtifacts(join(scenario, "candidate-runtime", "tcsf-home", "tasks", fixture.taskId)) };
  }
  const after = { sourceIndex: await fileHash(sourceIndex), activeIndex: await fileHash(activeIndex), candidateHost: await fileHash(candidateHost), capturedAt: new Date().toISOString() };
  const observations = { parent, after, unchanged: parent.sourceIndex === after.sourceIndex && parent.activeIndex === after.activeIndex && parent.candidateHost === after.candidateHost, candidateTerminalObserved: scenarioResult?.terminalObserved ?? false, candidateCleanupSucceeded: scenarioResult?.cleanupSucceeded ?? false, candidatePid: scenarioResult?.candidatePid ?? null, registryCheck, result };
  const verdict = id === "C-01" ? Boolean((registryCheck as { loadedExactlyOnce?: boolean } | undefined)?.loadedExactlyOnce && observations.unchanged) : id === "C-02" ? Boolean((registryCheck as { exact?: boolean } | undefined)?.exact && observations.unchanged) : evaluateScenario(id, observations);
  await writeFile(join(scenario, "stable-state-after.json"), `${JSON.stringify(after, null, 2)}\n`);
  await writeFile(join(scenario, "result.json"), `${JSON.stringify({ id, verdict: verdict ? "PASS" : "FAIL", oracle: observations, observedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(JSON.stringify({ id, verdict: verdict ? "PASS" : "FAIL", scenario, candidatePid: observations.candidatePid, terminalObserved: observations.candidateTerminalObserved, cleanupSucceeded: observations.candidateCleanupSucceeded }));
  if (!verdict) process.exitCode = 3;
}

async function createFixture(id: string, scenario: string): Promise<{ taskId: string; packetPath: string }> {
  const repo = join(scenario, "fixture-repo");
  await mkdir(repo, { recursive: true });
  const git = async (args: string[]) => { const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }); const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]); const code = await child.exited; if (code !== 0) throw new Error(stderr); return stdout.trim(); };
  await git(["init", "-b", "main"]); await Bun.write(join(repo, "README.md"), `candidate ${id}\n`); await git(["add", "."]); await git(["-c", "user.email=tcsf@example.invalid", "-c", "user.name=TCSF", "commit", "-m", "fixture"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  const taskId = `candidate-${id.toLowerCase()}`;
  const specPath = join(scenario, "spec.md"); const verificationPath = join(scenario, "verification.md"); const outputName = `${id.toLowerCase()}.txt`;
  const verificationGate = join(scenario, "candidate-c07-verification-gate");
  const verificationCommand = id === "C-07" ? `test -f \"${verificationGate}\" && test \"$(cat ${outputName})\" = \"candidate execution complete.\"` : `test \"$(cat ${outputName})\" = \"candidate execution complete.\"`;
  await Bun.write(specPath, `Create ${outputName} containing exactly candidate execution complete.\n`); await Bun.write(verificationPath, `${verificationCommand}\n`);
  const packet = { schemaVersion: 1, taskId, title: `Genuine ${id} candidate workflow`, approvalId: `${taskId}-approval`, approvedAt: new Date().toISOString(), artifacts: { spec: { path: "spec.md", sha256: await fileHash(specPath), size: (await Bun.file(specPath).size) }, verification: { path: "verification.md", sha256: await fileHash(verificationPath), size: (await Bun.file(verificationPath).size) } }, repositories: [{ repoKey: "primary", canonicalPath: repo, baseSha, role: "primary", writableScope: [outputName] }], acceptanceCriteria: [{ id: "candidate-output", description: "candidate output is correct", verificationCommand, expectedExitCode: 0 }], policy: { maxWallTimeHours: 1, maxImplementationRetries: 3, maxVerificationRetries: 3, maxReviewRetries: 2, maxCandidateValidationRetries: 1 } };
  const packetPath = join(scenario, "packet.json"); await Bun.write(packetPath, `${JSON.stringify(packet, null, 2)}\n`); return { taskId, packetPath };
}

function evaluateScenario(id: string, observations: Record<string, any>): boolean {
  if (!observations.unchanged || !observations.candidateTerminalObserved || !observations.candidateCleanupSucceeded || !(Number(observations.candidatePid) > 0)) return false;
  if (id === "C-07" && (observations.result?.candidateExecution as { operationObservations?: { workerKilled?: boolean } } | null)?.operationObservations?.workerKilled !== true) return false;
  const execution = observations.result?.candidateExecution as { task?: { phase?: string }; run?: { status?: string } } | null;
  if (id === "C-03") return execution?.task?.phase === "ready_for_acceptance" && execution.run?.status === "terminal";
  if (id === "C-09" || id === "C-10") return execution?.task?.phase === "ready_for_acceptance";
  return execution?.task?.phase === "ready_for_acceptance" || execution?.task?.phase === "waiting_for_decision";
}
function counts(values: string[]): Record<string, number> { return values.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] ?? 0) + 1; return out; }, {}); }
async function fileHash(path: string): Promise<string> { try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch { return "missing"; } }
async function json(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function text(path: string): Promise<string> { try { return await readFile(path, "utf8"); } catch { return ""; } }
async function collectArtifacts(root: string): Promise<string[]> { try { const entries = await (await import("node:fs/promises")).readdir(root, { recursive: true }); return entries.map(String); } catch { return []; } }
