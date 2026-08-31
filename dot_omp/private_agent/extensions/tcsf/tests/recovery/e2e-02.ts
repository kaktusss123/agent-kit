import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultFactory } from "../../runner.ts";
import { FsArtifactStore } from "../../adapters/fs-artifact-store.ts";
import { FsContractImporter } from "../../adapters/fs-contract-importer.ts";
import { GitWorkspace } from "../../adapters/git-workspace.ts";
import { createGitExec } from "../../adapters/git-exec.ts";
import { LocalProcessHost } from "../../adapters/local-process-host.ts";
import { LocalRunDriverHost } from "../../adapters/local-run-driver-host.ts";
import { OmpRpcAgentRuntime } from "../../adapters/omp/rpc-runtime.ts";
import { OmpCandidateRuntime } from "../../adapters/omp/candidate-runtime.ts";
import { ShellVerificationRunner } from "../../adapters/shell-verification.ts";
import { OmpReviewer } from "../../adapters/omp/reviewer.ts";
import { treeHash } from "../../conformance/validate-report.ts";

const root = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
const sourceTreeHash = await treeHash(join(import.meta.dir, "..", ".."));
const scenario = join(root, "reports", "e2e", "E2E-02", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(scenario, { recursive: true });
await writeFile(join(scenario, "runner-source.ts"), await Bun.file(import.meta.path).text());
const fixture = await mkdtemp(join(tmpdir(), "tcsf-e2e02-repair-"));
const repo = join(fixture, "repo"); const tcsfHome = join(scenario, "tcsf-home"); await mkdir(repo, { recursive: true });
async function git(args: string[]): Promise<string> { const result = await createGitExec().exec(args, repo); return result.stdout; }
await git(["init"]); await writeFile(join(repo, "README.md"), "fixture\n"); await git(["add", "."]); await git(["-c", "user.email=tcsf@example.invalid", "-c", "user.name=TCSF", "commit", "-m", "fixture"]); const baseSha = (await git(["rev-parse", "HEAD"])).trim();
const specText = "Implement repair.txt with the exact text: repaired by the same implementer session.\n"; const verificationText = "The first verification invocation must fail deterministically outside the writable worktree; every later invocation must pass only when repair.txt exists.\n";
await writeFile(join(scenario, "spec.md"), specText); await writeFile(join(scenario, "verification.md"), verificationText); const verificationScript = join(scenario, "verify.sh"); await writeFile(verificationScript, `#!/bin/sh\nset -eu\ntest -f repair.txt\n`);
const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const packet = { schemaVersion: 1 as const, taskId: "e2e-02", title: "same-session verification repair", approvalId: "e2e-02-approval", approvedAt: new Date().toISOString(), artifacts: { spec: { path: "spec.md", sha256: await hash(join(scenario, "spec.md")), size: Buffer.byteLength(specText) }, verification: { path: "verification.md", sha256: await hash(join(scenario, "verification.md")), size: Buffer.byteLength(verificationText) } }, repositories: [{ repoKey: "primary", canonicalPath: repo, baseSha, role: "primary" as const, writableScope: ["repair.txt"] }], acceptanceCriteria: [{ id: "verification-repair", description: "verification passes after repair", verificationCommand: `sh ${verificationScript}`, expectedExitCode: 0 }], policy: { maxWallTimeHours: 1, maxImplementationRetries: 2, maxVerificationRetries: 2, maxReviewRounds: 1, maxCandidateValidationRounds: 1, requireSecurityReview: false, securityReviewTriggers: [] } };
const factory = createDefaultFactory(tcsfHome, message => { void writeFile(join(scenario, "notification.log"), `${message}\n`, { flag: "a" }); }, `e2e02-controller-${process.pid}`, undefined, { driverProcessPath: join(import.meta.dir, "e2e-02-driver.ts") });
const imported = await factory.importApprovedContract(packet, scenario); const started = await factory.startRun(imported.id); await writeFile(join(scenario, "controller-launch.json"), `${JSON.stringify({ pid: process.pid, driver: started.driver, startedAt: new Date().toISOString(), baseSha }, null, 2)}\n`);
let status: Awaited<ReturnType<typeof factory.getStatus>> | undefined; const deadline = Date.now() + 300_000; while (Date.now() < deadline) { status = await factory.getStatus(imported.id); if (["ready_for_acceptance", "failed", "cancelled", "completed"].includes(status.task.phase)) break; await new Promise(resolve => setTimeout(resolve, 1_000)); }
const run = status?.run; const runRoot = join(tcsfHome, "tasks", imported.id, "runs", run?.id ?? started.run.id); const events = await Bun.file(join(runRoot, "driver-events.jsonl")).text().catch(() => ""); const verificationAttempts = (await readdir(join(runRoot, "verification")).catch(() => [])).filter(name => name.startsWith("injected-verification-")).length; const execution = run?.activeExecutionId ? await Bun.file(join(tcsfHome, "tasks", imported.id, "runs", run.id, "executions", `${run.activeExecutionId}.json`)).json().catch(() => null) : null; const turnNames = (await readdir(join(runRoot, "executions", "turns")).catch(() => [])).filter(name => name.endsWith(".complete.json")); const sessionIds = execution ? [execution.agentSession?.sessionId] : []; const sourceStatus = await git(["status", "--short"]);
await writeFile(join(scenario, "process-boundaries.json"), `${JSON.stringify({ initiatingController: process.pid, managedDriver: started.driver, isolatedRepository: repo }, null, 2)}\n`); await writeFile(join(scenario, "git-before.json"), `${JSON.stringify({ repo, baseSha }, null, 2)}\n`); await writeFile(join(scenario, "git-after.json"), `${JSON.stringify({ repo, sourceStatus }, null, 2)}\n`); const passed = status?.task.phase === "ready_for_acceptance" && run?.status === "terminal" && verificationAttempts >= 2 && turnNames.length >= 2 && sessionIds.length === 1 && sourceStatus.length === 0;
await writeFile(join(scenario, "verdict.json"), `${JSON.stringify({ id: "E2E-02", verdict: passed ? "PASS" : "FAIL", taskPhase: status?.task.phase, runStatus: run?.status, verificationAttempts, turnNames, execution, sourceStatus, sourceTreeHash, observedAt: new Date().toISOString() }, null, 2)}\n`); console.log(JSON.stringify({ id: "E2E-02", verdict: passed ? "PASS" : "FAIL", scenario, taskPhase: status?.task.phase, verificationAttempts, turnCount: turnNames.length })); if (!passed) process.exitCode = 1;
await rm(fixture, { recursive: true, force: true });
