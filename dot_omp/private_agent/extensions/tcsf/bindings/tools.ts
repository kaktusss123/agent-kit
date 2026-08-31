import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { TcsfFactory } from "../app/factory.ts";
import type { DecisionRequest } from "../core/types.ts";

interface StatusParams { taskId: string; }
interface DecisionParams extends DecisionRequest {}
interface CheckpointParams { taskId: string; runId: string; message: string; }
function ok(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
function fail(error: unknown) { return { content: [{ type: "text" as const, text: `TCSF error: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: {} }; }

export function registerTcsfTools(pi: ExtensionAPI, factory: TcsfFactory): void {
  const z = pi.zod;
  pi.registerTool({ name: "tcsf_status", label: "TCSF Status", description: "Inspect durable TCSF task and run status.", parameters: z.object({ taskId: z.string() }), execute: async (_id, params) => { try { const input = params as StatusParams; return ok(await factory.getStatus(input.taskId)); } catch (error) { return fail(error); } } });
  pi.registerTool({ name: "tcsf_request_decision", label: "TCSF Decision", description: "Persist a critical decision request with evidence and concrete options.", parameters: z.object({ taskId: z.string(), runId: z.string(), id: z.string(), category: z.enum(["behavior_change", "api_contract", "security", "destructive_operation", "scope_expansion", "acceptance_criteria_change", "architecture_violation", "publication", "unprovable_criterion", "exhausted_repair"]), question: z.string(), evidence: z.array(z.object({ taskId: z.string(), runId: z.string().optional(), relativePath: z.string(), sha256: z.string().optional() })), options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), consequences: z.string() })), recommendation: z.string(), consequenceOfDelay: z.string(), resumeStage: z.string() }), execute: async (_id, params) => { try { const request = params as DecisionParams; await factory.requestDecision(request); return ok({ decisionId: request.id, status: "open" }); } catch (error) { return fail(error); } } });
  pi.registerTool({ name: "tcsf_checkpoint", label: "TCSF Checkpoint", description: "Record optional progress metadata; workflow correctness does not depend on this.", parameters: z.object({ taskId: z.string(), runId: z.string(), message: z.string() }), execute: async (_id, params) => { const checkpoint = params as CheckpointParams; return ok({ recorded: true, ...checkpoint }); } });
  pi.registerTool({ name: "tcsf_review_result", label: "TCSF Review Result", description: "Submit one schema-validated result for the bound reviewer execution.", parameters: z.object({ executionId: z.string(), verdict: z.enum(["pass", "fail", "decision_required"]), summary: z.string(), findings: z.array(z.object({ file: z.string().optional(), behavior: z.string(), violatedContract: z.string(), severity: z.enum(["blocking", "non_blocking"]), expectedCorrection: z.string() })) }), execute: async () => fail(new Error("review result submission requires a bound reviewer execution")) });
}
