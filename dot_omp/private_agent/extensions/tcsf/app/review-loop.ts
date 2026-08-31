import type { ReviewResult } from "../core/review.ts";
export function hasBlockingFindings(result: ReviewResult): boolean { return result.verdict !== "pass" || result.findings.some(finding => finding.severity === "blocking"); }
