import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { AgentRuntime } from "../../ports/agent-runtime.ts";
import type { ReviewInput, ReviewPort } from "../../ports/review.ts";
import type { ReviewFinding, ReviewResult } from "../../core/review.ts";
import { createGitExec } from "../git-exec.ts";
const MAX_EVIDENCE = 120_000;
const REVIEW_SCHEMA = '{"verdict":"pass|fail|decision_required","summary":"string","findings":[{"file":"optional string","behavior":"string","violatedContract":"string","severity":"blocking|non_blocking","expectedCorrection":"string"}]}';

export class OmpReviewer implements ReviewPort {
  constructor(private readonly runtime: AgentRuntime, private readonly sessionDirectory: string, private readonly model?: string) {}
  async review(input: ReviewInput): Promise<ReviewResult> {
    const reviewNumber = await this.allocateReviewNumber(input.runId);
    const [diff, status] = await Promise.all([createGitExec().execQuiet(["diff", "HEAD", "--"], input.cwd), createGitExec().execQuiet(["status", "--short"], input.cwd)]);
    const untracked = await untrackedEvidence(input.cwd, status.stdout);
    const evidence = `Git status:\n${status.stdout}\n\nGit diff HEAD:\n${diff.stdout}\n\nUntracked file contents:\n${untracked}`.slice(0, MAX_EVIDENCE);
    const systemPrompt = `You are an independent reviewer. Do not modify files or use tools. Return exactly one JSON object matching this exact schema: ${REVIEW_SCHEMA}. Do not emit Markdown, prose, pseudo-tool calls, alternate fields, or any other JSON object.`;
    const session = await this.runtime.createSession({ cwd: input.cwd, workspaceRoots: [input.cwd], readOnlyRoots: [input.cwd], systemPrompt, role: "reviewer", sessionDirectory: this.sessionDirectory, model: this.model, noTools: true });
    const handle = await this.runtime.resumeSession(session);
    const attempts: Array<Record<string, unknown>> = [];
    try {
      const first = await this.runAttempt(handle, `Review task ${input.taskId}, run ${input.runId}, titled ${input.contractTitle}. Contract summary and factory evidence: ${input.contractSummary}. Inspect only the current worktree and Git evidence below. If factory verification passed and there is no contradictory evidence, return pass with no findings. Return exactly one JSON object matching this exact schema and no other output: ${REVIEW_SCHEMA}.\n${evidence}`, attempts, "initial");
      if (first.ok) return first.result;
      const repaired = await this.runAttempt(handle, `Your previous response failed strict schema validation: ${first.error}. This is the one and only repair turn. Return exactly one complete JSON object and no prose, Markdown, pseudo-tool call, alternate fields, or second object. Required exact schema: ${REVIEW_SCHEMA}.`, attempts, "repair");
      if (!repaired.ok) throw new Error(`reviewer protocol failure after one repair turn: ${repaired.error}`);
      return repaired.result;
    } finally {
      try { await this.recordAttempt(input, reviewNumber, session, handle, systemPrompt, attempts, null); } finally { await this.runtime.close(handle); }
    }
  }
  private async allocateReviewNumber(runId: string): Promise<number> {
    const directory = join(this.sessionDirectory, "review-attempts"); await mkdir(directory, { recursive: true }); const base = safeName(runId);
    for (let number = 1; number <= 10_000; number += 1) {
      const claim = join(directory, `${base}-${number}.claim`);
      try { await writeFile(claim, `${JSON.stringify({ runId, reviewNumber: number, claimedAt: new Date().toISOString() })}\n`, { flag: "wx" }); return number; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    throw new Error(`review attempt limit exhausted for ${runId}`);
  }
  private async runAttempt(handle: Awaited<ReturnType<AgentRuntime["resumeSession"]>>, prompt: string, attempts: Array<Record<string, unknown>>, phase: string): Promise<{ ok: true; result: ReviewResult } | { ok: false; error: string }> {
    const turn = await this.runtime.sendTurn(handle, { prompt }); const result = await this.runtime.waitForTurn(handle, turn); const output = result.outputText ?? "";
    try { const parsed = parseReview(output); attempts.push({ phase, promptSha256: sha256(prompt), outputText: output, parse: "valid", turn, result }); return { ok: true, result: parsed }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); attempts.push({ phase, promptSha256: sha256(prompt), outputText: output, parse: "invalid", parserError: message, turn, result }); return { ok: false, error: message }; }
  }
  private async recordAttempt(input: ReviewInput, reviewNumber: number, session: unknown, handle: unknown, systemPrompt: string, attempts: readonly Record<string, unknown>[], error: string | null): Promise<void> {
    const destination = join(this.sessionDirectory, "review-attempts", `${safeName(input.runId)}-${reviewNumber}.json`);
    await writeFile(destination, `${JSON.stringify({ taskId: input.taskId, runId: input.runId, reviewerExecutionId: input.reviewerExecutionId, attemptId: `${input.runId}:review:${reviewNumber}`, reviewNumber, sourceRevision: input.sourceRevision ?? null, model: this.model ?? null, provider: "omp-rpc", role: "reviewer", ompInvocation: "omp --mode rpc --no-title --no-extensions --no-skills --no-rules --no-tools --auto-approve", session, handle, cwd: input.cwd, workspaceRoots: [input.cwd], readOnlyRoots: [input.cwd], toolNames: [], toolsAllowed: false, systemPromptSha256: sha256(systemPrompt), attempts, repairCount: Math.max(0, attempts.length - 1), protocolError: error, rawFrames: [], rawFramesNote: "AgentRuntime exposes parsed turn results but not raw protocol frames.", capturedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  }
}

async function untrackedEvidence(cwd: string, status: string): Promise<string> { const lines: string[] = []; for (const line of status.split("\n")) { if (!line.startsWith("?? ")) continue; const relative = line.slice(3).trim(); const path = resolve(cwd, relative); if (!(path === resolve(cwd) || path.startsWith(`${resolve(cwd)}/`))) continue; try { lines.push(`${relative}:\n${await readFile(path, "utf8")}`); } catch { lines.push(`${relative}: <unreadable>`); } } return lines.join("\n").slice(0, MAX_EVIDENCE); }
function parseReview(text: string): ReviewResult { const trimmed = text.trim(); if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error("reviewer output must be one complete JSON object"); let value: unknown; try { value = JSON.parse(trimmed); } catch { throw new Error("reviewer output is not valid JSON"); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer result must be a JSON object"); const record = value as Record<string, unknown>; if (Object.keys(record).some(key => !["verdict", "summary", "findings"].includes(key))) throw new Error("reviewer result has unknown fields"); if (!["pass", "fail", "decision_required"].includes(String(record.verdict)) || typeof record.summary !== "string" || !Array.isArray(record.findings)) throw new Error("reviewer result failed exact schema validation"); return { verdict: record.verdict as ReviewResult["verdict"], summary: record.summary, findings: record.findings.map(parseFinding) }; }
function parseFinding(value: unknown): ReviewFinding { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer finding failed schema validation"); const record = value as Record<string, unknown>; if (Object.keys(record).some(key => !["file", "behavior", "violatedContract", "severity", "expectedCorrection"].includes(key))) throw new Error("reviewer finding has unknown fields"); if (typeof record.behavior === "string" && typeof record.violatedContract === "string" && typeof record.expectedCorrection === "string" && ["blocking", "non_blocking"].includes(String(record.severity)) && (record.file === undefined || typeof record.file === "string")) return { file: typeof record.file === "string" ? record.file : undefined, behavior: record.behavior, violatedContract: record.violatedContract, severity: record.severity as ReviewFinding["severity"], expectedCorrection: record.expectedCorrection }; throw new Error("reviewer finding failed schema validation"); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, "_"); }
