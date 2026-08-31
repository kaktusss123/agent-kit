import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { reproducibleTreeHash } from "./manifest.ts";
export type ReportStatus = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED_BY_DEPENDENCY";
export interface CatalogEntry { id: string; kind: "hypothesis" | "e2e" | "candidate" | "acceptance"; title: string; normativeText?: string; requiredActors: string[]; requiredProcessBoundaries: string[]; requiredPreconditions: string[]; requiredObservations: string[]; requiredEvidenceFiles: string[]; linkedHypotheses: string[]; linkedAcceptanceCriteria: string[]; definitionHash: string; }
interface Catalog { normativeSpec: string; normativeSpecSha256: string; entries: CatalogEntry[]; }
interface Report { acceptanceRoot: string; sourceRoot: string; sourceTreeHash: string; catalogPath: string; hypotheses: Record<string, { verdict: string; evidence?: string[] }>; hypothesisCards?: Record<string, { verdict: string; evidence?: string[] }>; componentProbes: Record<string, { verdict: ReportStatus; evidence?: string[] }>; e2e: Record<string, { verdict: ReportStatus; evidence?: string[]; sourceTreeHash?: string; runnerSource?: string; realOmpBoundary?: boolean; processBoundaries?: string[]; requiresMutation?: boolean }>; candidate: Record<string, { verdict: ReportStatus; evidence?: string[]; sourceTreeHash?: string; runnerSource?: string }>; acceptanceCriteria: Record<string, { verdict: "PASS" | "FAIL"; evidence?: string[] }>; verification?: { unit?: { command: string; passed: number; failed: number; expectations: number; completedAt: string; artifact: string } }; }
const allowedHypotheses = new Set(["CONFIRMED", "REJECTED_WITH_FALLBACK", "BLOCKED"]); const allowedStatuses = new Set<ReportStatus>(["PASS", "FAIL", "NOT_RUN", "BLOCKED_BY_DEPENDENCY"]);
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])); return value; }
export async function validateReport(reportPath: string): Promise<string[]> {
  const errors: string[] = []; const report = await loadJson<Report>(reportPath, errors, "report"); if (!report) return errors; const reportBase = dirname(reportPath); for (const field of ["acceptanceRoot", "sourceRoot", "catalogPath"] as const) report[field] = resolve(reportBase, report[field]); const catalogPath = report.catalogPath; const catalog = await loadJson<Catalog>(catalogPath, errors, "catalog"); if (!catalog) return errors;
  const expected = new Map<string, CatalogEntry>(); for (const entry of catalog.entries ?? []) { if (expected.has(entry.id)) errors.push(`duplicate catalog id ${entry.id}`); expected.set(entry.id, entry); if (!entry.title || !entry.definitionHash || !entry.requiredEvidenceFiles) errors.push(`incomplete catalog entry ${entry.id}`); }
  for (const entry of catalog.entries ?? []) { const { definitionHash, ...definition } = entry; const actualHash = createHash("sha256").update(JSON.stringify(stable(definition))).digest("hex"); if (actualHash !== definitionHash) errors.push(`${entry.id} definition hash mismatch`); }
  for (const [kind, count] of [["hypothesis", 11], ["e2e", 10], ["candidate", 10], ["acceptance", 25]] as const) if (catalog.entries.filter(entry => entry.kind === kind).length !== count) errors.push(`catalog ${kind} count mismatch`);
  const specCandidates = [resolve(dirname(catalogPath), "../../../../../TCSF_IMPLEMENTATION_SPEC.md"), resolve(dirname(catalogPath), "../../TCSF_IMPLEMENTATION_SPEC.md")]; let specFound = false; for (const specPath of specCandidates) { try { const spec = await readFile(specPath); if (createHash("sha256").update(spec).digest("hex") !== catalog.normativeSpecSha256) errors.push("catalog normative spec hash is stale"); specFound = true; break; } catch {} } if (!specFound) errors.push(`missing normative spec ${specCandidates[0]}`);
  try { if (await treeHash(report.sourceRoot) !== report.sourceTreeHash) errors.push("report source tree hash is stale"); } catch { errors.push(`missing source root ${report.sourceRoot}`); }
  const sections: Array<[keyof Report, "hypothesis" | "e2e" | "candidate" | "acceptance"]> = [["hypotheses", "hypothesis"], ["e2e", "e2e"], ["candidate", "candidate"], ["acceptanceCriteria", "acceptance"]];
  for (const [field, kind] of sections) { const values = report[field] as Record<string, { verdict?: string; evidence?: string[]; sourceTreeHash?: string }> | undefined; if (!values || typeof values !== "object") { errors.push(`missing report section ${String(field)}`); continue; } for (const id of Object.keys(values)) { const entry = expected.get(id); if (!entry || entry.kind !== kind) { errors.push(`${id} is not a ${kind} catalog entry`); continue; } const card = values[id]; if (kind === "hypothesis" ? !allowedHypotheses.has(card.verdict ?? "") : kind === "acceptance" ? !["PASS", "FAIL"].includes(card.verdict ?? "") : !allowedStatuses.has(card.verdict as ReportStatus)) errors.push(`${id} has invalid verdict ${card.verdict}`); await validateEvidence(report, entry, card, errors); } }
  for (const [field, kind] of sections) { const values = report[field] as Record<string, { verdict?: string; evidence?: string[]; sourceTreeHash?: string; runnerSource?: string; requiresMutation?: boolean }> | undefined; if (!values) continue; for (const [id, card] of Object.entries(values)) { if (card.verdict !== "PASS" || (kind !== "e2e" && kind !== "candidate")) continue; if (!card.runnerSource) errors.push(`${id} PASS is missing runner source`); else { try { const source = await readFile(resolve(report.sourceRoot, card.runnerSource), "utf8"); if (!source.includes(id)) errors.push(`${id} PASS runner source does not match canonical id`); } catch { errors.push(`${id} PASS runner source is missing`); } } if (kind === "e2e" && !(await hasProcessBoundaryEvidence(report, card.evidence))) errors.push(`${id} PASS lacks observed process boundaries`); if (kind === "e2e" && card.requiresMutation === true && !card.evidence?.some(path => path.includes("git-after") || path.includes("mutation"))) errors.push(`${id} PASS lacks mutation evidence`); } }
  if (report.hypothesisCards) { for (const entry of catalog.entries.filter(item => item.kind === "hypothesis")) { const card = report.hypothesisCards[entry.id]; const final = report.hypotheses[entry.id]; if (!card) errors.push(`missing hypothesis card ${entry.id}`); else { if (!allowedHypotheses.has(card.verdict)) errors.push(`${entry.id} card has invalid verdict ${card.verdict}`); if (final && card.verdict !== final.verdict) errors.push(`${entry.id} hypothesis card contradicts final verdict`); } } }
  if (!report.componentProbes || typeof report.componentProbes !== "object") errors.push("missing report section componentProbes");
  for (const [id, card] of Object.entries(report.componentProbes ?? {})) { if (!/^P-[A-Za-z0-9-]+$/u.test(id)) errors.push(`component probe id is not canonical ${id}`); if (!allowedStatuses.has(card.verdict)) errors.push(`${id} has invalid verdict ${card.verdict}`); }
  for (const entry of catalog.entries) { const section = entry.kind === "hypothesis" ? report.hypotheses : entry.kind === "e2e" ? report.e2e : entry.kind === "candidate" ? report.candidate : report.acceptanceCriteria; if (!section || !(entry.id in section)) errors.push(`missing report entry ${entry.id}`); }
  const longRun = (report as Report & { longRunMechanics?: { status?: ReportStatus; mechanicsRun?: boolean } }).longRunMechanics; if (longRun?.status === "PASS" && longRun.mechanicsRun !== true) errors.push("long-run report claims PASS without mechanics evidence");
  if (report.verification?.unit) { const unit = report.verification.unit; const artifact = resolve(report.acceptanceRoot, unit.artifact); try { const text = await readFile(artifact, "utf8"); const match = text.match(/(\d+) pass[\s\S]*?(\d+) fail[\s\S]*?(\d+) expect/u); if (!match || unit.passed !== Number(match[1]) || unit.failed !== Number(match[2]) || unit.expectations !== Number(match[3])) errors.push("unit verification counts contradict command artifact"); } catch { errors.push(`missing unit artifact ${artifact}`); } }
  for (const [id, card] of Object.entries(report.e2e ?? {})) if (card.verdict === "PASS") {
    const verdictPath = card.evidence?.find(path => path.endsWith("/verdict.json"));
    if (!verdictPath) { errors.push(`${id} PASS has no verdict evidence`); continue; }
    try {
      const verdict = JSON.parse(await readFile(resolve(report.acceptanceRoot, verdictPath), "utf8")) as Record<string, unknown>;
      if (verdict.id !== id || verdict.verdict !== "PASS") errors.push(`${id} PASS verdict evidence is not self-consistent`);
      if (id === "E2E-02" && (!(Number(verdict.verificationAttempts) >= 2) || !Array.isArray(verdict.turnNames) || verdict.turnNames.length < 2 || typeof verdict.sourceTreeHash !== "string")) errors.push("E2E-02 lacks immutable repair-turn evidence");
      if (id === "E2E-03" && (!(Number(verdict.reviewRounds) >= 2) || !(Number(verdict.implementationRounds) >= 2) || !Array.isArray(verdict.reviewAttemptRecords) || verdict.reviewAttemptRecords.length < 2)) errors.push("E2E-03 lacks fresh reviewer-attempt evidence");
      if (id === "E2E-04" && (verdict.processSeparated !== true || verdict.waiting !== true || verdict.resolved !== true)) errors.push("E2E-04 lacks process-separated decision evidence");
      if (id === "E2E-05" && (verdict.killed !== true || !(Number(verdict.workerPid) > 0) || Number(verdict.initialCompletions) < 1 || verdict.noDuplicateLogicalTurns !== true)) errors.push("E2E-05 lacks worker-loss observations");
      if (id === "E2E-06" && (verdict.foregrounded !== true || verdict.denied !== true || verdict.operatorSucceeded !== true || verdict.operatorPromptContainsMarker === true || verdict.historyMarkerObserved !== true || verdict.wrongNonceRejected !== true || verdict.replayRejected !== true || verdict.postReturnSucceeded !== true || !(Number(verdict.operatorPid) > 0) || verdict.sessionBefore !== verdict.sessionAfter)) errors.push("E2E-06 lacks exact operator continuity observations");
      if (id === "E2E-07" && verdict.containmentEnforced !== true) errors.push("E2E-07 lacks enforceable containment evidence");
      if (id === "E2E-08" && (verdict.crashed !== true || verdict.failpointObserved !== true || verdict.failpointOwnerVerified !== true)) errors.push("E2E-08 lacks exact crash failpoint observations");
      if (id === "E2E-10" && (verdict.activeRuntimeEvidence !== true || verdict.sourceInspectionOnly === true)) errors.push("E2E-10 lacks active-runtime evidence");
    } catch { errors.push(`${id} PASS verdict evidence is unreadable`); }
  }
  return errors;
}
async function hasProcessBoundaryEvidence(report: Report, evidence: string[] | undefined): Promise<boolean> {
  const relativePath = evidence?.find(path => path.endsWith("/process-boundaries.json"));
  if (!relativePath) return false;
  try {
    const value = JSON.parse(await readFile(resolve(report.acceptanceRoot, relativePath), "utf8")) as unknown;
    const processIds = (item: unknown, key = ""): number => {
      if (Array.isArray(item)) return item.reduce((count, child) => count + processIds(child, key), 0);
      if (!item || typeof item !== "object") return /(?:pid|process|controller)/iu.test(key) && typeof item === "number" && item > 0 ? 1 : 0;
      return Object.entries(item).reduce((count, [childKey, child]) => count + processIds(child, childKey), 0);
    };
    return processIds(value) > 0;
  } catch { return false; }
}
async function validateEvidence(report: Report, entry: CatalogEntry, card: { verdict?: string; evidence?: string[]; sourceTreeHash?: string }, errors: string[]): Promise<void> {
  if (card.verdict === "NOT_RUN" || card.verdict === "BLOCKED_BY_DEPENDENCY" || card.verdict === "BLOCKED" || card.verdict === "FAIL") return;
  if (!Array.isArray(card.evidence) || card.evidence.length === 0) { errors.push(`${entry.id} missing evidence`); return; }
  if (card.sourceTreeHash && card.sourceTreeHash !== report.sourceTreeHash) errors.push(`${entry.id} evidence is stale`);
  if (entry.kind === "candidate" && !card.evidence.some(path => path.includes("immutable-parent") || path.includes("candidate-parent"))) errors.push(`${entry.id} lacks immutable parent evidence`);
  if (entry.kind === "candidate" && !card.evidence.some(path => path.endsWith("/result.json"))) errors.push(`${entry.id} lacks candidate result evidence`);
  if (entry.kind === "e2e") {
    if (card.evidence.some(path => path.includes("/probes/") || path.includes("P-"))) errors.push(`${entry.id} references a relabeled component probe`);
    for (const required of ["runner-source.ts", "verdict.json", "process-boundaries.json", ...(entry.id === "E2E-10" ? [] : ["git-before.json", "git-after.json"])]) if (!card.evidence.some(path => path.endsWith(`/${required}`))) errors.push(`${entry.id} lacks ${required}`);
    if (entry.id === "E2E-10" && !card.evidence.some(path => path.endsWith("/loader-report.json"))) errors.push("E2E-10 lacks loader report");
  }
  for (const evidence of card.evidence) {
    const path = resolve(report.acceptanceRoot, evidence);
    if (!path.startsWith(resolve(report.acceptanceRoot) + sep)) { errors.push(`${entry.id} evidence escapes acceptance root`); continue; }
    try { const metadata = await lstat(path); if (metadata.isSymbolicLink()) errors.push(`${entry.id} evidence is symlinked`); else if (metadata.isFile() && (await stat(path)).size === 0) errors.push(`${entry.id} has empty evidence ${evidence}`); } catch { errors.push(`${entry.id} missing evidence file ${evidence}`); }
  }
  const verdictPath = card.evidence.find(path => path.endsWith("/verdict.json"));
  if (verdictPath) { try { const verdict = JSON.parse(await readFile(resolve(report.acceptanceRoot, verdictPath), "utf8")) as { id?: string; verdict?: string }; if (verdict.id !== entry.id || verdict.verdict !== "PASS") errors.push(`${entry.id} verdict evidence contradicts report`); } catch { errors.push(`${entry.id} verdict evidence is not valid JSON`); } }
}
async function loadJson<T>(path: string, errors: string[], label: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { errors.push(`cannot read ${label}: ${String(error)}`); return undefined; } }
export const treeHash = reproducibleTreeHash;
if (import.meta.main) { const reportPath = process.argv[2]; if (!reportPath) { console.error("usage: bun run conformance/validate-report.ts <acceptance.json>"); process.exit(2); } const errors = await validateReport(resolve(reportPath)); if (errors.length > 0) { console.error(errors.join("\n")); process.exit(1); } console.log("conformance report valid"); }
