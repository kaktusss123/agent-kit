import type { ReviewResult } from "../core/review.ts";

export interface ReviewInput {
  taskId: string;
  runId: string;
  reviewerExecutionId?: string;
  cwd: string;
  contractTitle: string;
  contractSummary: string;
  sourceRevision?: string;
  signal?: AbortSignal;
}
export interface ReviewPort { review(input: ReviewInput): Promise<ReviewResult>; }
