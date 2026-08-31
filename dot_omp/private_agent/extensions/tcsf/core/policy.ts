import type { FailureClass, RunCounters, RetryPolicy, TaskPolicy } from "./types.ts";

export function defaultTaskPolicy(): TaskPolicy {
  return { maxWallTimeHours: 12, maxImplementationRetries: 5, maxReviewRounds: 3, maxCandidateValidationRounds: 2, requireSecurityReview: false, securityReviewTriggers: [] };
}

export function defaultRunCounters(): RunCounters {
  return { infrastructureRetries: 0, protocolRepairs: 0, verificationRepairs: 0, reviewRepairs: 0, candidateValidationRepairs: 0 };
}

export function retryCount(counters: RunCounters, failureClass: FailureClass): number {
  switch (failureClass) {
    case "infrastructure": return counters.infrastructureRetries;
    case "protocol": return counters.protocolRepairs;
    case "verification": return counters.verificationRepairs;
    case "semantic": return counters.reviewRepairs;
    case "candidate_validation": return counters.candidateValidationRepairs;
    default: return Number.POSITIVE_INFINITY;
  }
}

export function retryLimit(policy: RetryPolicy, failureClass: FailureClass): number {
  switch (failureClass) {
    case "infrastructure": return policy.infrastructureRetries;
    case "protocol": return policy.protocolRepairs;
    case "verification": return policy.verificationRepairs;
    case "semantic": return policy.reviewRepairs;
    case "candidate_validation": return policy.candidateValidationRepairs;
    default: return 0;
  }
}

export function canRetry(counters: RunCounters, policy: RetryPolicy, failureClass: FailureClass): boolean {
  return retryCount(counters, failureClass) < retryLimit(policy, failureClass);
}

export function incrementRetry(counters: RunCounters, failureClass: FailureClass): RunCounters {
  switch (failureClass) {
    case "infrastructure": return { ...counters, infrastructureRetries: counters.infrastructureRetries + 1 };
    case "protocol": return { ...counters, protocolRepairs: counters.protocolRepairs + 1 };
    case "verification": return { ...counters, verificationRepairs: counters.verificationRepairs + 1 };
    case "semantic": return { ...counters, reviewRepairs: counters.reviewRepairs + 1 };
    case "candidate_validation": return { ...counters, candidateValidationRepairs: counters.candidateValidationRepairs + 1 };
    default: return counters;
  }
}
