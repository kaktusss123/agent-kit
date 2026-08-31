import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OmpCandidateRuntime } from "../../adapters/omp/candidate-runtime.ts";

const root = process.env.TCSF_ACCEPTANCE_ROOT ?? join(process.env.HOME ?? ".", ".omp", "tcsf-acceptance-20260830");
const scenario = join(root, "reports", "e2e", "E2E-10", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(scenario, { recursive: true });
await writeFile(join(scenario, "runner-source.ts"), await Bun.file(import.meta.path).text());

const sourceRoot = join(import.meta.dir, "..", "..");
const loaderDirectory = join(scenario, "candidate-runtime");
const candidate = await new OmpCandidateRuntime("omp", 20_000).inspectCandidate({ extensionPath: join(sourceRoot, "index.ts"), cwd: join(sourceRoot, "../../../../.."), sessionDirectory: loaderDirectory });
const candidateDetail = JSON.parse(candidate.output) as { commandNames?: string[]; toolNames?: string[]; duplicateCommands?: string[]; duplicateTools?: string[]; candidatePid?: number; registeredExtensionTools?: string[] };
const commandNames = candidateDetail.commandNames ?? [];
const toolNames = candidateDetail.toolNames ?? [];
const duplicateCommands = candidateDetail.duplicateCommands ?? [];
const duplicateTools = candidateDetail.duplicateTools ?? [];
const expectedTools = ["tcsf_status", "tcsf_request_decision", "tcsf_checkpoint"];
const tcsfCommands = commandNames.filter(name => name.startsWith("tcsf_"));
const activeExtensions = tcsfCommands.length > 0 && expectedTools.every(name => toolNames.includes(name)) ? ["tcsf"] : [];
const runtimeObservation = { protocol: "omp-rpc", candidatePid: candidate.candidatePid, candidatePassed: candidate.passed, commandNames, tcsfCommands, toolNames, duplicateCommands, duplicateTools, expectedTools, registeredExtensionTools: candidateDetail.registeredExtensionTools ?? [], observedAt: new Date().toISOString() };
await writeFile(join(scenario, "loader-report.json"), `${JSON.stringify(runtimeObservation, null, 2)}\n`);
await writeFile(join(scenario, "process-boundaries.json"), `${JSON.stringify({ initiatingController: process.pid, candidateProcess: candidate.candidatePid, candidateBundle: candidate.bundlePath, isolatedCandidateHome: loaderDirectory, observation: "active loader RPC responses" }, null, 2)}\n`);
await writeFile(join(scenario, "terminology-report.json"), `${JSON.stringify({ sourceInspection: false, observedFromRuntime: true }, null, 2)}\n`);
const passed = activeExtensions.length === 1 && candidate.passed && duplicateCommands.length === 0 && duplicateTools.length === 0 && expectedTools.every(name => toolNames.includes(name));
await writeFile(join(scenario, "verdict.json"), `${JSON.stringify({ id: "E2E-10", verdict: passed ? "PASS" : "FAIL", activeExtensions, candidatePassed: candidate.passed, commandNames, tcsfCommands, toolNames, duplicateCommands, duplicateTools, activeRuntimeEvidence: true, sourceInspectionOnly: false, sourceInspection: false }, null, 2)}\n`);
console.log(JSON.stringify({ id: "E2E-10", verdict: passed ? "PASS" : "FAIL", activeExtensions, candidatePid: candidate.candidatePid, sourceInspection: false }));
if (!passed) process.exitCode = 1;
