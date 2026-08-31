import type { DecisionRequest, DecisionResolution } from "../core/types.ts";
export interface HumanDecisionPort {
  publish(request: DecisionRequest): Promise<void>;
  readResolution(decisionId: string): Promise<DecisionResolution | null>;
}
