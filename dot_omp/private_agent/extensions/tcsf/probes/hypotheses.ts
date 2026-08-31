import { createHash } from "node:crypto";

export type HypothesisVerdict = "CONFIRMED" | "REJECTED_WITH_FALLBACK" | "BLOCKED";
export interface HypothesisExperiment {
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly requiresLiveRuntime: boolean;
}
export interface HypothesisCard {
  readonly id: `H-${string}`;
  readonly title: string;
  readonly requiredExperiment: string;
  readonly experiment: HypothesisExperiment;
  readonly successConditions: readonly string[];
  readonly fallback: string;
  readonly linkedAcceptanceCriteria: readonly string[];
  readonly definitionHash: string;
}
export interface HypothesisEvidence {
  readonly id: string;
  readonly title: string;
  readonly definitionHash: string;
  readonly verdict: HypothesisVerdict;
  readonly observed: string;
  readonly evidencePaths: readonly string[];
  readonly selectedFallback: string | null;
  readonly fallbackEvidencePaths: readonly string[];
  readonly downstream: string;
  readonly dependsOn: readonly string[];
}

const DEFINITIONS = [
  ["H-01", "OMP RPC supports durable multi-turn sessions", "Create, close, restart, resume, and complete a nonce-bearing multi-turn session.", ["same persisted session history after process restart", "terminal lifecycle evidence is present"], "Use a public SDK or CLI resume path.", ["AC-03", "AC-05", "AC-07"]],
  ["H-02", "OMP RPC exposes enough lifecycle and cancellation data", "Exercise normal completion, tool activity, cancellation, and unexpected transport death.", ["each lifecycle outcome is classified from protocol/process evidence", "no prose parsing is required"], "Combine protocol events, process exit, timeout, and session inspection.", ["AC-05", "AC-08", "AC-17"]],
  ["H-03", "Same-session foreground handoff works", "Resume an exact session interactively, exercise a nonce, deny a concurrent writer, and reacquire autonomous control.", ["history and nonce survive handoff", "concurrent writer is denied"], "Use the documented same-session OMP resume command and operator handoff.", ["AC-03", "AC-06"]],
  ["H-04", "Current ctx.newSession can be isolated as an interactive adapter", "Probe ctx.newSession with isolated cwd, session storage, and write policy.", ["interactive adapter is isolated", "operator session cannot write outside scope"], "Keep the core on RPC refs and use ctx.newSession only as a bounded adapter.", ["AC-03", "AC-18"]],
  ["H-05", "Unexpected OMP UI requests can be handled or rejected", "Send or induce an unexpected UI request and observe bounded rejection or handling.", ["request cannot wait invisibly forever", "failure is durable and classified"], "Reject unexpected UI requests as protocol blockers.", ["AC-04", "AC-14"]],
  ["H-06", "Candidate runtime can be isolated from stable runtime", "Run a fixture workflow under candidate code and compare stable runtime and state fingerprints.", ["candidate code is loaded", "stable runtime and state remain unchanged"], "Use explicit candidate paths, isolated HOME/state, and a fresh loader harness.", ["AC-20", "AC-21"]],
  ["H-07", "OMP tool hooks can enforce session-bound write policy", "Bind a fixture implementer session and attempt allowed, forbidden, symlink, and traversal writes.", ["allowed worktree write succeeds", "forbidden writes fail before mutation", "session binding is unambiguous"], "Retain post-turn Git and filesystem integrity enforcement and disable unsafe direct tools.", ["AC-06", "AC-15"]],
  ["H-08", "Structured reviewer result is reliable", "Submit valid, invalid, missing, malformed, and duplicate reviewer results through the bound protocol.", ["only one schema-valid result is accepted", "invalid cases become protocol failures", "final prose cannot override the result"], "Parse final JSON against a strict schema and allow one repair turn.", ["AC-11", "AC-12"]],
  ["H-09", "HERDR can provide live OMP foregrounding on this machine", "Probe a safe HERDR attach and return without modifying HERDR installation.", ["live attach preserves session and writer safety"], "Use OMP same-session handoff; HERDR remains optional.", ["AC-03", "AC-19"]],
  ["H-10", "Legacy task runtime can coexist read-only during migration", "Compare representative legacy manifests before and after loading TCSF and verify they remain unconsumed.", ["legacy bytes remain unchanged", "no duplicate active registration occurs"], "Keep legacy content historical and disable its active entrypoint.", ["AC-23", "AC-24"]],
  ["H-11", "Managed run driver outlives the initiating OMP session", "Terminate the initiating OMP session, continue the driver, reject duplicate drivers, kill the driver, and recover with tcsf_resume.", ["single ownership persists", "replacement does not duplicate stage effects"], "Use a managed local driver and explicit recovery command.", ["AC-04", "AC-07", "AC-08"]],
] as const;
const EXPERIMENTS: Record<string, HypothesisExperiment> = {
  "H-01": { command: ["bun", "tests/recovery/e2e-02.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
  "H-02": { command: ["bun", "tests/recovery/e2e-01.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
  "H-03": { command: ["bun", "tests/recovery/e2e-06.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
  "H-04": { command: ["bun", "tests/recovery/e2e-07.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
  "H-05": { command: ["bun", "test", "tests/reviewer.test.ts"], timeoutMs: 120_000, requiresLiveRuntime: false },
  "H-06": { command: ["bun", "tests/recovery/candidate-pack.ts"], timeoutMs: 1_800_000, requiresLiveRuntime: true },
  "H-07": { command: ["bun", "test", "tests/workspace-safety.test.ts"], timeoutMs: 120_000, requiresLiveRuntime: false },
  "H-08": { command: ["bun", "test", "tests/reviewer.test.ts"], timeoutMs: 120_000, requiresLiveRuntime: false },
  "H-09": { command: ["bun", "tests/recovery/e2e-06.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
  "H-10": { command: ["bun", "test", "tests/contract-import.test.ts"], timeoutMs: 120_000, requiresLiveRuntime: false },
  "H-11": { command: ["bun", "tests/recovery/e2e-01.ts"], timeoutMs: 300_000, requiresLiveRuntime: true },
};
function hashDefinition(definition: readonly unknown[]): string { return createHash("sha256").update(JSON.stringify(definition)).digest("hex"); }
export const HYPOTHESES: readonly HypothesisCard[] = DEFINITIONS.map(([id, title, requiredExperiment, successConditions, fallback, linkedAcceptanceCriteria]) => ({ id: id as `H-${string}`, title, requiredExperiment, experiment: EXPERIMENTS[id], successConditions, fallback, linkedAcceptanceCriteria, definitionHash: hashDefinition([id, title, requiredExperiment, successConditions, fallback, linkedAcceptanceCriteria]) }));
export function hypothesisById(id: string): HypothesisCard { const card = HYPOTHESES.find(item => item.id === id); if (!card) throw new Error(`unknown hypothesis ${id}`); return card; }
export function validateHypothesisEvidence(result: HypothesisEvidence): void {
  const card = hypothesisById(result.id);
  if (!card.experiment.command.length || card.experiment.timeoutMs <= 0) throw new Error(`${result.id} has no executable experiment`);
  if (result.title !== card.title) throw new Error(`${result.id} has the wrong canonical title`);
  if (result.definitionHash !== card.definitionHash) throw new Error(`${result.id} has the wrong definition hash`);
  if (!["CONFIRMED", "REJECTED_WITH_FALLBACK", "BLOCKED"].includes(result.verdict)) throw new Error(`${result.id} has an invalid verdict`);
  if (!result.evidencePaths.length || !result.observed.trim()) throw new Error(`${result.id} has no durable evidence`);
  if (result.verdict === "REJECTED_WITH_FALLBACK" && (!result.selectedFallback || !result.fallbackEvidencePaths.length)) throw new Error(`${result.id} rejected-with-fallback lacks successful fallback evidence`);
  for (const dependency of result.dependsOn) hypothesisById(dependency);
}
export function assertCompleteHypotheses(results: readonly HypothesisEvidence[]): void {
  const seen = new Map<string, HypothesisEvidence>();
  for (const result of results) { validateHypothesisEvidence(result); if (seen.has(result.id)) throw new Error(`duplicate hypothesis ${result.id}`); seen.set(result.id, result); }
  if (seen.size !== HYPOTHESES.length) throw new Error("hypothesis catalog is incomplete");
  for (const result of results) for (const dependency of result.dependsOn) { const target = seen.get(dependency); if (!target || target.verdict !== "CONFIRMED") throw new Error(`${result.id} depends on non-confirmed hypothesis ${dependency}`); }
}
