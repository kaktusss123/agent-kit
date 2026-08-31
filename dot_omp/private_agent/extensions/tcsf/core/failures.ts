import type { ClassifiedFailure, FailureClass } from "./types.ts";

export function classifyFailure(failureClass: FailureClass, message: string, details?: Record<string, unknown>): ClassifiedFailure {
  const retryable = failureClass === "infrastructure" || failureClass === "protocol" || failureClass === "verification" || failureClass === "semantic" || failureClass === "candidate_validation";
  return { failureClass, message, details, retryable, atTimestamp: new Date().toISOString() };
}

export function isTerminalFailure(failure: ClassifiedFailure): boolean {
  return !failure.retryable || failure.failureClass === "policy" || failure.failureClass === "workspace" || failure.failureClass === "cancelled";
}
