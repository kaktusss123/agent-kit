import type { CriticalDecisionCategory, DecisionRequest, DecisionResolution } from "./types.ts";

const CRITICAL_CATEGORIES: Record<CriticalDecisionCategory, true> = {
  behavior_change: true, api_contract: true, security: true, destructive_operation: true,
  scope_expansion: true, acceptance_criteria_change: true, architecture_violation: true,
  publication: true, unprovable_criterion: true, exhausted_repair: true,
};

export function isCriticalDecisionCategory(value: string): value is CriticalDecisionCategory {
  return value in CRITICAL_CATEGORIES;
}

export function validateDecisionRequest(request: DecisionRequest): void {
  if (!isCriticalDecisionCategory(request.category)) throw new Error(`invalid decision category: ${request.category}`);
  if (!request.question.trim()) throw new Error("decision question is required");
  if (request.evidence.length === 0) throw new Error("decision evidence is required");
  if (request.options.length < 2) throw new Error("decision needs at least two options");
  if (!request.recommendation.trim()) throw new Error("decision recommendation is required");
  if (!request.consequenceOfDelay.trim()) throw new Error("decision consequence of delay is required");
}

export function validateDecisionResolution(request: DecisionRequest, resolution: DecisionResolution): void {
  if (request.status !== "open") throw new Error(`decision is not open: ${request.status}`);
  if (request.id !== resolution.decisionId) throw new Error("decision id mismatch");
  if (!request.options.some(option => option.id === resolution.selectedOptionId)) throw new Error("selected option is not available");
  if (!resolution.resolvedBy.trim()) throw new Error("resolvedBy is required");
}
