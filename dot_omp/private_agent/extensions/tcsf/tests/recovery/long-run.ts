import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
const scenarioRoot = join(root, "recovery", "long-run", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(scenarioRoot, { recursive: true });
await writeFile(join(scenarioRoot, "runner-source.ts"), await Bun.file(import.meta.path).text());
async function run(command: string[], cwd: string, output: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", detached: true });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  await writeFile(join(scenarioRoot, `${output}.stdout`), stdout); await writeFile(join(scenarioRoot, `${output}.stderr`), stderr);
  return { command, pid: child.pid, exitCode, stdoutTail: stdout.slice(-2_000), stderrTail: stderr.slice(-2_000) };
}
const cwd = import.meta.dir;
const registry = await run([process.execPath, "run", "hypotheses.ts"], cwd, "hypothesis-registry", { TCSF_ACCEPTANCE_ROOT: join(scenarioRoot, "hypothesis-acceptance") });
const mechanics: Record<string, unknown>[] = [];
for (let index = 1; index <= 3; index += 1) mechanics.push(await run([process.execPath, "run", "e2e-01.ts"], cwd, `mechanics-${index}`, { TCSF_ACCEPTANCE_ROOT: join(scenarioRoot, `mechanics-${index}`) }));
const restarts = [await run([process.execPath, "run", "e2e-08.ts"], cwd, "restart-crash", { TCSF_ACCEPTANCE_ROOT: join(scenarioRoot, "restart-crash") })];
const passed = registry.exitCode === 0 && mechanics.every(run => run.exitCode === 0) && restarts.every(run => run.exitCode === 0);
await writeFile(join(scenarioRoot, "resource-observation.json"), `${JSON.stringify({ registry, mechanics, restarts, restartObservations: restarts.map(run => ({ command: run.command, exitCode: run.exitCode, processId: run.pid })), acceleratedClock: "isolated fixture iterations with real process control", capturedAt: new Date().toISOString() }, null, 2)}\n`);
await writeFile(join(scenarioRoot, "commands.jsonl"), `${JSON.stringify({ command: "bun run hypotheses.ts", capturedAt: new Date().toISOString() })}\n${mechanics.map((_, index) => JSON.stringify({ command: `bun run e2e-01.ts #${index + 1}`, capturedAt: new Date().toISOString() })).join("\n")}\n${restarts.map(run => JSON.stringify({ command: run.command, capturedAt: new Date().toISOString() })).join("\n")}\n`);
await writeFile(join(scenarioRoot, "verdict.json"), `${JSON.stringify({ id: "LONG-RUN", verdict: passed ? "PASS" : "FAIL", scenarioRoot, registryExitCode: registry.exitCode, mechanics, restarts, restartObserved: restarts.every(run => run.exitCode === 0) }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
