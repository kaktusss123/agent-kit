import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateInspectionInput, CandidateInspectionResult, CandidatePackInput, CandidatePackResult, CandidateRuntimePort, CandidateScenarioInput, CandidateScenarioResult } from "../../ports/candidate-runtime.ts";
import { decodeRpcLine } from "./protocol.ts";
import { createManifest, MANIFEST_FILE } from "../../conformance/manifest.ts";
interface CandidateProcess {
  stdin: { write(data: string): number | Promise<number>; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
  pid?: number;
}
interface ScenarioManifest { id: string; operation: string; scenarioRoot: string; taskId: string; packetPath: string; tcsfHome: string; packRunId?: string; packSequence?: number; sourceSnapshotHash?: string; }
interface CandidateFrame { type: string; id?: string; success?: boolean; error?: string; protocol?: string; authToken?: string; data?: unknown; [key: string]: unknown; }

export class OmpCandidateRuntime implements CandidateRuntimePort {
  constructor(private readonly ompCommand = "omp", private readonly timeoutMs = 30_000) {}

  async inspectCandidate(input: CandidateInspectionInput): Promise<CandidateInspectionResult> {
    const bundlePath = await this.bundle(input);
    const environment = { ...(await this.isolatedEnvironment(input)), ...input.environment, TCSF_CANDIDATE_REGISTRY_PATH: join(input.sessionDirectory, "registry.json") };
    const process = this.startOmp(bundlePath, input, environment);
    const output: string[] = [];
    const errors: string[] = [];
    const stderrTask = collect(process.stderr, errors);
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ready = false;
    const responses = new Map<string, CandidateFrame>();
    let stopped = false;
    const shutdown = async (): Promise<void> => { if (!stopped) { stopped = true; await stop(process); } };
    try {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline && (!ready || responses.size < 2)) {
        const frame = await nextFrame(reader, decoder, () => buffer, value => { buffer = value; }, Math.max(1, deadline - Date.now()));
        if (!frame) break;
        output.push(JSON.stringify(frame));
        if (frame.type === "ready" && !ready) {
          ready = true;
          await process.stdin.write(`${JSON.stringify({ id: "candidate-commands", type: "get_available_commands" })}\n${JSON.stringify({ id: "candidate-state", type: "get_state" })}\n`);
        } else if (frame.type === "response" && frame.id) responses.set(frame.id, frame);
      }
      const commandNames = names(responses.get("candidate-commands")?.data, "commands");
      const stateToolNames = names(responses.get("candidate-state")?.data, "dumpTools");
      const registryFile = await readFile(join(input.sessionDirectory, "registry.json"), "utf8").catch(() => "");
      const registeredExtensionTools = registryFile ? (JSON.parse(registryFile) as { tools?: unknown[] }).tools?.filter((name): name is string => typeof name === "string") ?? [] : [];
      const toolNames = [...stateToolNames, ...registeredExtensionTools];
      const duplicateCommands = duplicates(commandNames);
      const duplicateTools = duplicates(toolNames);
      const passed = Boolean(ready && responses.get("candidate-commands")?.success && responses.get("candidate-state")?.success && duplicateCommands.length === 0 && duplicateTools.length === 0);
      const evidencePath = join(input.sessionDirectory, "candidate-inspection.json");
      const probe = { protocol: "omp-rpc", layer: "loader", ready, candidatePid: process.pid, responses: Object.fromEntries(responses), commandNames, toolNames, stateToolNames, registeredExtensionTools, duplicateCommands, duplicateTools, output, stderr: errors.join("") };
      await writeFile(evidencePath, `${JSON.stringify(probe, null, 2)}\n`);
      return { passed, bundlePath, candidatePid: process.pid, commandNames, toolNames, duplicateCommands, duplicateTools, output: JSON.stringify(probe), evidencePath };
    } finally {
      await shutdown();
      await stderrTask.catch(() => undefined);
    }
  }

  async executeScenario(input: CandidateScenarioInput): Promise<CandidateScenarioResult> {
    const bundlePath = await this.bundle(input);
    const environment = { ...(await this.isolatedEnvironment(input)), ...input.environment };
    const manifest = JSON.parse(await readFile(input.scenarioManifestPath, "utf8")) as ScenarioManifest;
    if (manifest.id !== input.scenarioId || !manifest.operation || !manifest.scenarioRoot || !manifest.taskId || !manifest.packetPath || !manifest.tcsfHome || (input.packRunId && manifest.packRunId !== input.packRunId) || (input.packSequence && manifest.packSequence !== input.packSequence)) throw new Error(`invalid candidate scenario manifest: ${input.scenarioManifestPath}`);
    const candidateHostPath = join(input.extensionPath, "..", "candidate-host.ts");
    await readFile(candidateHostPath, "utf8");
    const authToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const candidateProcess = Bun.spawn([globalThis.process.execPath, candidateHostPath, authToken], { cwd: input.cwd, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as CandidateProcess;
    const stdout = candidateProcess.stdout.getReader();
    const decoder = new TextDecoder();
    const stderr: string[] = [];
    const stderrTask = collect(candidateProcess.stderr, stderr);
    let buffer = "";
    let terminalObserved = false;
    let terminal: CandidateFrame | undefined;
    let cleanupSucceeded = false;
    let scenarioResult: CandidateScenarioResult | undefined;
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    try {
      const ready = await nextFrame(stdout, decoder, () => buffer, value => { buffer = value; }, timeoutMs);
      if (!ready || ready.type !== "ready" || ready.protocol !== "tcsf-candidate-host" || ready.authToken !== authToken) throw new Error("candidate host did not provide an authenticated ready frame");
      await candidateProcess.stdin.write(`${JSON.stringify({ id: "scenario", type: "run_scenario", authToken, seq: 1, manifest })}\n`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await nextFrame(stdout, decoder, () => buffer, value => { buffer = value; }, Math.max(1, deadline - Date.now()));
        if (!frame) break;
        if (frame.type === "scenario_result" && frame.id === "scenario") { terminalObserved = true; terminal = frame; break; }
      }
      if (!terminalObserved) throw new Error("candidate host exited or timed out before terminal result");
      if (!terminal) throw new Error("candidate host reported terminal state without a result frame");
      const eventPath = join(input.sessionDirectory, `scenario-${input.scenarioId}.json`);
      const event = { protocol: "tcsf-candidate-host", scenarioId: input.scenarioId, packRunId: input.packRunId, packSequence: input.packSequence, sourceSnapshotHash: input.sourceSnapshotHash, candidatePid: candidateProcess.pid, candidateSourceSnapshot: input.extensionPath, candidateBundle: bundlePath, manifest, terminal, stderr: stderr.join(""), observedAt: new Date().toISOString() };
      await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
      scenarioResult = { scenarioId: input.scenarioId, passed: terminal.success === true, candidatePid: candidateProcess.pid, exitCode: terminal.success === true ? 0 : 1, eventPath, artifactPaths: [eventPath, ...artifactPaths(terminal.data)], output: JSON.stringify(event), cleanupSucceeded: false, terminalObserved };
    } finally {
      cleanupSucceeded = await stop(candidateProcess, authToken, 2);
      await stderrTask.catch(() => undefined);
      if (terminalObserved) {
        const eventPath = join(input.sessionDirectory, `scenario-${input.scenarioId}.json`);
        const event = JSON.parse(await readFile(eventPath, "utf8").catch(() => "{}")) as Record<string, unknown>;
        event.cleanupSucceeded = cleanupSucceeded;
        await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
      }
    }
    if (!scenarioResult) throw new Error("candidate scenario did not produce a result");
    return { ...scenarioResult, cleanupSucceeded };
  }

  async executePack(input: CandidatePackInput): Promise<CandidatePackResult> {
    await mkdir(input.scenarioRoot, { recursive: true });
    const packRunId = `candidate-pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const sourceSnapshotRoot = join(input.scenarioRoot, "immutable-source");
    await cp(join(input.extensionPath, ".."), sourceSnapshotRoot, { recursive: true, force: false });
    const sourceManifest = await createManifest(sourceSnapshotRoot);
    await writeFile(join(sourceSnapshotRoot, MANIFEST_FILE), `${JSON.stringify(sourceManifest, null, 2)}\n`);
    const extensionPath = join(sourceSnapshotRoot, "index.ts");
    const scenarios: Array<{ id: string; sequence?: number; inspection?: CandidateInspectionResult; scenario?: CandidateScenarioResult }> = [];
    for (const [index, id] of ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07", "C-08", "C-09", "C-10"].entries()) {
      const sequence = index + 1;
      if (id === "C-01" || id === "C-02") { const inspection = await this.inspectCandidate({ ...input, extensionPath, sessionDirectory: join(input.scenarioRoot, id, "candidate-runtime") }); await mkdir(join(input.scenarioRoot, id), { recursive: true }); await writeFile(join(input.scenarioRoot, id, "candidate-isolation.json"), `${JSON.stringify({ scenarioId: id, candidateSourceSnapshot: extensionPath, sourceSnapshotRoot, sourceSnapshotHash: sourceManifest.treeHash, immutableManifest: join(sourceSnapshotRoot, MANIFEST_FILE), bundlePath: inspection.bundlePath, candidatePid: inspection.candidatePid, stableExtensionPath: input.extensionPath, isolatedSessionDirectory: join(input.scenarioRoot, id, "candidate-runtime") }, null, 2)}\n`); scenarios.push({ id, sequence, inspection }); continue; }
      const scenarioRoot = join(input.scenarioRoot, id);
      const fixture = await createCandidateFixture(id, scenarioRoot);
      const scenarioManifestPath = join(scenarioRoot, "scenario-manifest.json");
      await writeFile(scenarioManifestPath, `${JSON.stringify({ id, operation: `candidate-${id.toLowerCase()}-workflow`, scenarioRoot, taskId: fixture.taskId, packetPath: fixture.packetPath, tcsfHome: join(scenarioRoot, "candidate-runtime", "tcsf-home"), packRunId, packSequence: sequence, sourceSnapshotHash: sourceManifest.treeHash })}\n`);
      scenarios.push({ id, sequence, scenario: await this.executeScenario({ ...input, extensionPath, sessionDirectory: join(scenarioRoot, "candidate-runtime"), scenarioId: id, scenarioManifestPath, timeoutMs: input.timeoutMs ?? 300_000, packRunId, packSequence: sequence, sourceSnapshotHash: sourceManifest.treeHash }) });
    }
    const result = { packRunId, sourceSnapshotRoot, sourceSnapshotHash: sourceManifest.treeHash, scenarios, passed: scenarios.every(item => item.inspection?.passed ?? item.scenario?.passed === true) };
    await writeFile(join(input.scenarioRoot, "candidate-pack.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    return result;
  }

  private async bundle(input: CandidateInspectionInput): Promise<string> {
    await mkdir(input.sessionDirectory, { recursive: true });
    const bundlePath = join(input.sessionDirectory, "candidate.bundle.js");
    const bundle = Bun.spawn(["bun", "build", input.extensionPath, "--target=bun", `--outfile=${bundlePath}`], { cwd: input.cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(bundle.stdout).text();
    const stderr = await new Response(bundle.stderr).text();
    const exitCode = await bundle.exited;
    if (exitCode !== 0) throw new Error(JSON.stringify({ layer: "bundle", exitCode, stdout, stderr }));
    return bundlePath;
  }

  private async isolatedEnvironment(input: CandidateInspectionInput): Promise<Record<string, string>> {
    const home = join(input.sessionDirectory, "home");
    const tcsfHome = join(input.sessionDirectory, "tcsf-home");
    const xdgConfig = join(input.sessionDirectory, "xdg-config");
    const xdgCache = join(input.sessionDirectory, "xdg-cache");
    await Promise.all([home, tcsfHome, xdgConfig, xdgCache].map(path => mkdir(path, { recursive: true })));
    return { ...(process.env as Record<string, string>), HOME: home, TCSF_HOME: tcsfHome, XDG_CONFIG_HOME: xdgConfig, XDG_CACHE_HOME: xdgCache };
  }

  private startOmp(bundlePath: string, input: CandidateInspectionInput, environment: Record<string, string>): CandidateProcess {
    return Bun.spawn([this.ompCommand, "--mode", "rpc", "--no-title", "--extension", bundlePath, "--no-skills", "--no-rules", "--cwd", input.cwd, "--session-dir", input.sessionDirectory, "--auto-approve"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: environment } as const) as CandidateProcess;
  }
}

async function createCandidateFixture(id: string, scenarioRoot: string): Promise<{ taskId: string; packetPath: string }> {
  await mkdir(scenarioRoot, { recursive: true });
  const repo = join(scenarioRoot, "fixture-repo");
  await mkdir(repo, { recursive: true });
  const git = async (args: string[]): Promise<string> => { const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }); const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]); if (await child.exited !== 0) throw new Error(stderr); return stdout.trim(); };
  await git(["init", "-b", "main"]); await git(["config", "user.email", "tcsf@example.invalid"]); await git(["config", "user.name", "TCSF"]); await writeFile(join(repo, "README.md"), `candidate ${id}\n`); await git(["add", "."]); await git(["commit", "-m", "fixture"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  const taskId = `candidate-${id.toLowerCase()}`; const outputName = `${id.toLowerCase()}.txt`; const specPath = join(scenarioRoot, "spec.md"); const verificationPath = join(scenarioRoot, "verification.md");
  await writeFile(specPath, `Create ${outputName} containing exactly candidate execution complete.\n`); await writeFile(verificationPath, `test \"$(cat ${outputName})\" = \"candidate execution complete.\"\n`);
  const packet = { schemaVersion: 1, taskId, title: `Genuine ${id} candidate workflow`, approvalId: `${taskId}-approval`, approvedAt: new Date().toISOString(), artifacts: { spec: { path: "spec.md", sha256: await hashFile(specPath), size: (await readFile(specPath)).byteLength }, verification: { path: "verification.md", sha256: await hashFile(verificationPath), size: (await readFile(verificationPath)).byteLength } }, repositories: [{ repoKey: "primary", canonicalPath: repo, baseSha, role: "primary", writableScope: [outputName] }], acceptanceCriteria: [{ id: "candidate-output", description: "candidate output is correct", verificationCommand: `test \"$(cat ${outputName})\" = \"candidate execution complete.\"`, expectedExitCode: 0 }], policy: { maxWallTimeHours: 1, maxImplementationRetries: 1, maxVerificationRetries: 1, maxReviewRounds: 1, maxCandidateValidationRounds: 1, requireSecurityReview: false, securityReviewTriggers: [] } };
  const packetPath = join(scenarioRoot, "packet.json"); await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`); return { taskId, packetPath };
}
async function hashFile(path: string): Promise<string> { const data = await readFile(path); const crypto = await import("node:crypto"); return crypto.createHash("sha256").update(data).digest("hex"); }
function names(value: unknown, key: string): string[] { if (!value || typeof value !== "object" || !(key in value) || !Array.isArray((value as Record<string, unknown>)[key])) return []; return ((value as Record<string, unknown>)[key] as unknown[]).filter(item => item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string").map(item => (item as { name: string }).name); }
function duplicates(values: string[]): string[] { return values.filter((value, index) => values.indexOf(value) !== index); }
function artifactPaths(value: unknown): string[] { return value && typeof value === "object" && "artifactPaths" in value && Array.isArray(value.artifactPaths) ? value.artifactPaths.filter((item): item is string => typeof item === "string") : []; }
async function collect(stream: ReadableStream<Uint8Array>, output: string[]): Promise<void> { output.push(await new Response(stream).text()); }
async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, getBuffer: () => string, setBuffer: (value: string) => void, timeoutMs: number): Promise<CandidateFrame | undefined> {
  let buffer = getBuffer();
  while (true) {
    const separator = buffer.indexOf("\n");
    if (separator >= 0) {
      const line = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 1);
      setBuffer(buffer);
      const frame = decodeRpcLine(line) as CandidateFrame | null;
      if (frame) return frame;
      continue;
    }
    const read = await Promise.race([reader.read(), delay(timeoutMs).then(() => ({ done: true as const, value: undefined }))]);
    if (read.done) { setBuffer(buffer); return undefined; }
    buffer += decoder.decode(read.value, { stream: true });
  }
}
async function stop(process: CandidateProcess, authToken?: string, seq?: number): Promise<boolean> { if (authToken && seq) { try { await process.stdin.write(`${JSON.stringify({ id: "shutdown", type: "shutdown", authToken, seq })}\n`); } catch {} } const exited = await Promise.race([process.exited.then(() => true), delay(1_000).then(() => false)]); if (!exited) { try { process.stdin.end(); process.kill("SIGTERM"); } catch {} const terminated = await Promise.race([process.exited.then(() => true), delay(2_000).then(() => false)]); if (!terminated) { try { process.kill("SIGKILL"); } catch {} await process.exited; return false; } } return true; }
function delay(ms: number): Promise<void> { return new Promise(resolve => { const timer = setTimeout(resolve, ms); if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref(); }); }
